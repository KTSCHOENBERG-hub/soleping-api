#!/usr/bin/env python3
"""Build the Just Me Ashleigh — Saltwater Cottage PDF."""
from pathlib import Path
from weasyprint import HTML, CSS

ROOT = Path(__file__).parent
SRC = ROOT / "src" / "document.html"
OUT_DIR = ROOT / "build"
OUT_DIR.mkdir(exist_ok=True)
OUT = OUT_DIR / "saltwater-cottage-plan.pdf"


def main() -> None:
    html = HTML(filename=str(SRC))
    html.write_pdf(target=str(OUT), presentational_hints=True)
    pdf_bytes = OUT.stat().st_size
    doc = HTML(filename=str(SRC)).render()
    print(f"Wrote {OUT} ({pdf_bytes/1024:.1f} KB, {len(doc.pages)} pages)")


if __name__ == "__main__":
    main()
