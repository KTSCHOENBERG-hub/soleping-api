# Just Me Ashleigh — The Saltwater Cottage

A 60-page coastal dream house model concept plan, sold as a digital download.

## Building the PDF

```bash
cd just-me-ashleigh
python3 build.py
```

Outputs `build/saltwater-cottage-plan.pdf`.

## Source layout

- `src/document.html` — the 60-page document
- `assets/css/print.css` — print/screen styles
- `assets/img/` — SVG illustrations, plans, elevations, mood boards
- `build.py` — HTML → PDF renderer (WeasyPrint)
