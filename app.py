"""
MT940 Amendment App

Upload a CSV bank statement export. The app reads the corresponding MT940
file from the configured network path, matches transactions by date and
amount, and produces an amended MT940 file with :87: Debtors Name fields
appended to each matched transaction.
"""

import os
import io
import re
from pathlib import Path
from datetime import datetime

from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    send_file,
    flash,
    session,
)
from werkzeug.utils import secure_filename

import mt940_parser
import csv_matcher

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-in-production")

# --- Configuration -----------------------------------------------------------
# Default MT940 directory; override with MT940_DIR env var or per-request form field
DEFAULT_MT940_DIR = os.environ.get("MT940_DIR", "/mnt/bank_statements")

UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", "/tmp/mt940_uploads")
ALLOWED_CSV_EXT = {".csv"}
ALLOWED_MT940_EXT = {".sta", ".mt940", ".txt", ""}   # MT940 files have varying extensions
MAX_CONTENT_LENGTH = 16 * 1024 * 1024   # 16 MB

app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
os.makedirs(UPLOAD_FOLDER, exist_ok=True)


# --- Helpers -----------------------------------------------------------------

def allowed_csv(filename: str) -> bool:
    return Path(filename).suffix.lower() in ALLOWED_CSV_EXT


def resolve_mt940_path(mt940_dir: str, filename: str) -> Path:
    """Safely resolve MT940 file path, preventing directory traversal."""
    base = Path(mt940_dir).resolve()
    target = (base / secure_filename(filename)).resolve()
    if not str(target).startswith(str(base)):
        raise ValueError("Invalid file path")
    return target


def list_mt940_files(mt940_dir: str) -> list:
    """Return MT940 files available in the configured directory."""
    try:
        p = Path(mt940_dir)
        if not p.exists():
            return []
        files = []
        for f in sorted(p.iterdir()):
            if f.is_file() and f.suffix.lower() in {".sta", ".mt940", ".txt", ""}:
                files.append(f.name)
        return files
    except PermissionError:
        return []


# --- Routes ------------------------------------------------------------------

@app.route("/")
def index():
    mt940_dir = request.args.get("mt940_dir", DEFAULT_MT940_DIR)
    mt940_files = list_mt940_files(mt940_dir)
    return render_template(
        "index.html",
        mt940_dir=mt940_dir,
        mt940_files=mt940_files,
        default_mt940_dir=DEFAULT_MT940_DIR,
    )


@app.route("/process", methods=["POST"])
def process():
    # --- Collect inputs ---
    mt940_dir = request.form.get("mt940_dir", DEFAULT_MT940_DIR).strip()
    mt940_filename = request.form.get("mt940_file", "").strip()
    csv_file = request.files.get("csv_file")

    # Custom column mappings (optional)
    date_cols = [c.strip() for c in request.form.get("date_columns", "").split(",") if c.strip()]
    amount_cols = [c.strip() for c in request.form.get("amount_columns", "").split(",") if c.strip()]
    debtor_cols = [c.strip() for c in request.form.get("debtor_columns", "").split(",") if c.strip()]

    # --- Validate ---
    errors = []

    if not mt940_filename:
        errors.append("Please select or enter an MT940 file name.")

    if not csv_file or csv_file.filename == "":
        errors.append("Please upload a CSV bank statement file.")
    elif not allowed_csv(csv_file.filename):
        errors.append("Uploaded file must be a .csv file.")

    if errors:
        for e in errors:
            flash(e, "error")
        return redirect(url_for("index", mt940_dir=mt940_dir))

    # --- Read MT940 ---
    try:
        mt940_path = resolve_mt940_path(mt940_dir, mt940_filename)
        mt940_text = mt940_path.read_text(encoding="utf-8", errors="replace")
    except (ValueError, FileNotFoundError, PermissionError) as exc:
        flash(f"Could not read MT940 file: {exc}", "error")
        return redirect(url_for("index", mt940_dir=mt940_dir))

    # --- Read CSV ---
    csv_text = csv_file.read().decode("utf-8-sig", errors="replace")  # handle BOM

    # --- Parse & match ---
    try:
        msg = mt940_parser.parse(mt940_text)
    except Exception as exc:
        flash(f"Failed to parse MT940 file: {exc}", "error")
        return redirect(url_for("index", mt940_dir=mt940_dir))

    column_map = {}
    if date_cols:
        column_map["date_columns"] = date_cols
    if amount_cols:
        column_map["amount_columns"] = amount_cols
    if debtor_cols:
        column_map["debtor_columns"] = debtor_cols

    try:
        stats = csv_matcher.match_transactions(msg, csv_text, column_map)
    except ValueError as exc:
        flash(str(exc), "error")
        return redirect(url_for("index", mt940_dir=mt940_dir))

    # --- Render amended MT940 ---
    amended_text = mt940_parser.render(msg)

    # --- Stream back as download ---
    stem = Path(mt940_filename).stem
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_filename = f"{stem}_amended_{timestamp}.sta"

    flash(
        f"Processed {stats['total']} transactions: "
        f"{stats['matched']} matched, {stats['unmatched']} unmatched.",
        "success",
    )

    return send_file(
        io.BytesIO(amended_text.encode("utf-8")),
        mimetype="text/plain",
        as_attachment=True,
        download_name=output_filename,
    )


@app.route("/preview", methods=["POST"])
def preview():
    """Return match results as JSON without downloading the file."""
    mt940_dir = request.form.get("mt940_dir", DEFAULT_MT940_DIR).strip()
    mt940_filename = request.form.get("mt940_file", "").strip()
    csv_file = request.files.get("csv_file")

    if not mt940_filename or not csv_file:
        return {"error": "Missing inputs"}, 400

    try:
        mt940_path = resolve_mt940_path(mt940_dir, mt940_filename)
        mt940_text = mt940_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return {"error": str(exc)}, 400

    csv_text = csv_file.read().decode("utf-8-sig", errors="replace")

    try:
        msg = mt940_parser.parse(mt940_text)
        stats = csv_matcher.match_transactions(msg, csv_text)
    except ValueError as exc:
        return {"error": str(exc)}, 400

    rows = []
    for tx in msg.transactions:
        rows.append({
            "date": tx.value_date,
            "amount": tx.amount,
            "dc": tx.debit_credit,
            "ref": tx.customer_ref,
            "debtor_name": tx.debtor_name or "",
            "matched": tx.debtor_name is not None,
        })

    return {
        "stats": stats,
        "transactions": rows,
    }


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=os.environ.get("FLASK_DEBUG", "0") == "1", port=port)
