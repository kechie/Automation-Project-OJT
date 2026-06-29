"""
One-time Excel budget importer for a Flask-SQLAlchemy application.

Expected model names:
    Office(id, office_slug, office_name)
    Project(id, office_id, aip_code, title)
    LineItem(
        id, project_id, sub_unit, row_name,
        ps, mooe, co,
        q1_target, q2_target, q3_target, q4_target,
        q1_actual, q2_actual
    )

Usage:
    python seed_budget_excel.py "PPA MonitoringForm_FY2026.1.15.2026.xlsx"

If your Flask module is not named "app", set it with:
    python seed_budget_excel.py budget.xlsx --app-module your_flask_module

By default, the app module must export app, db, Office, Project, and LineItem.
If your models live in a separate module, pass:
    python seed_budget_excel.py budget.xlsx --app-module app --models-module models
"""

from __future__ import annotations

import argparse
import importlib
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import pandas as pd


DEFAULT_START_ROW = 10

# Zero-based Excel column indexes.
COL_AIP_CODE = 0
COL_DESCRIPTION = 1

BUDGET_COLUMNS = {
    # Excel columns C:E.
    "aip": (2, 3, 4),
    # Excel columns G:I.
    "annual": (6, 7, 8),
}

# Excel columns M:P and R:S.
COL_Q1_TARGET = 12
COL_Q2_TARGET = 13
COL_Q3_TARGET = 14
COL_Q4_TARGET = 15
COL_Q1_ACTUAL = 17
COL_Q2_ACTUAL = 18

# Examples matched:
#   3000-2-03-OCYDO-16
#   1000-2-01-OCM-1-3
AIP_CODE_RE = re.compile(r"^\d{4}-\d+-\d{2}-[A-Za-z0-9.]+(?:-\d+)*$")


def clean_text(value: Any) -> str:
    """Return a stripped string, or an empty string for blank cells."""
    if pd.isna(value):
        return ""
    text = str(value).strip()
    return re.sub(r"\s+", " ", text)


def to_decimal(value: Any) -> Decimal:
    """Convert Excel numeric values to Decimal, defaulting blanks/bad values to 0.0."""
    if pd.isna(value) or value == "":
        return Decimal("0.0")
    if isinstance(value, Decimal):
        return value

    text = str(value).strip().replace(",", "")
    if text == "":
        return Decimal("0.0")

    # Handle common accounting format: (1,234.56)
    if text.startswith("(") and text.endswith(")"):
        text = f"-{text[1:-1]}"

    try:
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return Decimal("0.0")


def to_int(value: Any) -> int:
    """Convert target/actual cells to int, defaulting blanks/bad values to 0."""
    if pd.isna(value) or value == "":
        return 0
    text = str(value).strip().replace(",", "")
    if text == "":
        return 0
    try:
        return int(float(text))
    except ValueError:
        return 0


def get_cell(row: pd.Series, col_index: int) -> Any:
    """Safely fetch a cell from a pandas row by zero-based column index."""
    if col_index >= len(row):
        return None
    return row.iloc[col_index]


def is_standard_aip_code(value: str) -> bool:
    return bool(AIP_CODE_RE.match(value))


def should_skip_row(code: str, description: str) -> bool:
    """Skip blank rows and repeated header/helper rows."""
    if not code and not description:
        return True

    lowered_description = description.lower()
    lowered_code = code.lower()

    header_fragments = (
        "programs/ projects and activities",
        "aip ref. code",
        "target output",
        "actual output",
    )
    if any(fragment in lowered_description for fragment in header_fragments):
        return True
    if lowered_code in {"(1)", "aip ref. code"}:
        return True
    if lowered_description in {"(2)", "ps", "mooe", "co", "total"}:
        return True

    return False


def import_module_or_raise(module_name: str, purpose: str):
    try:
        return importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        if exc.name == module_name:
            raise RuntimeError(
                f"Could not import {purpose} module '{module_name}'.\n"
                f"Run this script from the folder that contains that module, or pass the "
                f"correct module name, for example:\n"
                f"  python seed_budget_excel.py budget.xlsx --app-module your_app_file\n\n"
                f"Do not include '.py' in the module name."
            ) from exc
        raise


def load_flask_objects(app_module_name: str, models_module_name: str | None):
    app_module = import_module_or_raise(app_module_name, "Flask app")
    models_module = (
        import_module_or_raise(models_module_name, "models")
        if models_module_name
        else app_module
    )

    app_missing = [name for name in ("app", "db") if not hasattr(app_module, name)]
    model_missing = [
        name for name in ("Office", "Project", "LineItem") if not hasattr(models_module, name)
    ]
    missing = app_missing + model_missing
    if missing:
        raise RuntimeError(
            "Missing required Flask/SQLAlchemy objects:\n"
            f"  app module '{app_module_name}' must export: app, db\n"
            f"  models module '{models_module_name or app_module_name}' must export: "
            "Office, Project, LineItem\n"
            f"  missing: {', '.join(missing)}"
        )
    return (
        app_module.app,
        app_module.db,
        models_module.Office,
        models_module.Project,
        models_module.LineItem,
    )


def seed_workbook(
    *,
    workbook_path: Path,
    app_module: str,
    models_module: str | None,
    budget_source: str,
    start_row: int,
    dry_run: bool,
) -> None:
    app, db, Office, Project, LineItem = load_flask_objects(app_module, models_module)
    ps_col, mooe_col, co_col = BUDGET_COLUMNS[budget_source]

    excel = pd.ExcelFile(workbook_path, engine="openpyxl")
    print(f"Loaded workbook: {workbook_path}")
    print(f"Found {len(excel.sheet_names)} sheet(s).")
    print(f"Budget source: {budget_source} columns")

    grand_total_projects = 0
    grand_total_line_items = 0

    with app.app_context():
        for sheet_name in excel.sheet_names:
            df = pd.read_excel(
                excel,
                sheet_name=sheet_name,
                header=None,
                dtype=object,
                engine="openpyxl",
            )

            office_name = clean_text(get_cell(df.iloc[1], 0)) if len(df) > 1 else sheet_name
            office_name = office_name or sheet_name

            print(f"\nProcessing sheet '{sheet_name}' ({len(df)} rows)...")

            office = Office.query.filter_by(office_slug=sheet_name).first()
            if office is None:
                office = Office(office_slug=sheet_name, office_name=office_name)
                db.session.add(office)
                db.session.flush()
                print(f"  Created office: {sheet_name} - {office_name}")
            else:
                if not getattr(office, "office_name", None) and office_name:
                    office.office_name = office_name
                print(f"  Using existing office: {sheet_name}")

            current_project = None
            sheet_project_count = 0
            sheet_line_item_count = 0
            pending_line_items = []

            for row_number, row in df.iloc[start_row - 1 :].iterrows():
                excel_row_number = row_number + 1
                code = clean_text(get_cell(row, COL_AIP_CODE))
                description = clean_text(get_cell(row, COL_DESCRIPTION))

                if should_skip_row(code, description):
                    continue

                if is_standard_aip_code(code) and description:
                    current_project = Project(
                        office_id=office.id,
                        aip_code=code,
                        title=description,
                    )
                    db.session.add(current_project)
                    db.session.flush()
                    sheet_project_count += 1
                    continue

                if description and current_project is not None:
                    sub_unit = code if code and not is_standard_aip_code(code) else None
                    line_item = LineItem(
                        project_id=current_project.id,
                        sub_unit=sub_unit,
                        row_name=description,
                        ps=to_decimal(get_cell(row, ps_col)),
                        mooe=to_decimal(get_cell(row, mooe_col)),
                        co=to_decimal(get_cell(row, co_col)),
                        q1_target=to_int(get_cell(row, COL_Q1_TARGET)),
                        q2_target=to_int(get_cell(row, COL_Q2_TARGET)),
                        q3_target=to_int(get_cell(row, COL_Q3_TARGET)),
                        q4_target=to_int(get_cell(row, COL_Q4_TARGET)),
                        q1_actual=to_int(get_cell(row, COL_Q1_ACTUAL)),
                        q2_actual=to_int(get_cell(row, COL_Q2_ACTUAL)),
                    )
                    pending_line_items.append(line_item)
                    sheet_line_item_count += 1
                    continue

                if description and current_project is None:
                    print(
                        f"  Skipped row {excel_row_number}: line item found before any project."
                    )

            if pending_line_items:
                db.session.add_all(pending_line_items)

            if dry_run:
                db.session.rollback()
                print(
                    f"  Dry run: would insert {sheet_project_count} project(s) "
                    f"and {sheet_line_item_count} line item(s)."
                )
            else:
                db.session.commit()
                print(
                    f"  Committed {sheet_project_count} project(s) "
                    f"and {sheet_line_item_count} line item(s)."
                )

            grand_total_projects += sheet_project_count
            grand_total_line_items += sheet_line_item_count

    print("\nImport complete.")
    print(f"Projects parsed: {grand_total_projects}")
    print(f"Line items parsed: {grand_total_line_items}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed Office, Project, and LineItem rows from a multi-tab Excel budget file."
    )
    parser.add_argument(
        "workbook",
        type=Path,
        help="Path to the Excel workbook to import.",
    )
    parser.add_argument(
        "--app-module",
        "--module",
        dest="app_module",
        default="app",
        help="Python module exporting app and db. Default: app",
    )
    parser.add_argument(
        "--models-module",
        default=None,
        help=(
            "Python module exporting Office, Project, and LineItem. "
            "Default: same as --app-module"
        ),
    )
    parser.add_argument(
        "--budget-source",
        choices=sorted(BUDGET_COLUMNS),
        default="annual",
        help="Use AIP amount columns C:E or annual budget columns G:I. Default: annual",
    )
    parser.add_argument(
        "--start-row",
        type=int,
        default=DEFAULT_START_ROW,
        help=f"First Excel row containing data. Default: {DEFAULT_START_ROW}",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and log the workbook, then roll back all database changes.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    workbook_path = args.workbook.resolve()

    if not workbook_path.exists():
        raise FileNotFoundError(f"Workbook not found: {workbook_path}")

    seed_workbook(
        workbook_path=workbook_path,
        app_module=args.app_module,
        models_module=args.models_module,
        budget_source=args.budget_source,
        start_row=args.start_row,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
