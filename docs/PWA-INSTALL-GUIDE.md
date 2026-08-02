# Keeping the PWA install guide up to date

**Single source of truth:** [`pwa-install-guide.js`](../pwa-install-guide.js)

That file drives:

- Web page → `/install-app.html`
- PDF → `/docs/gridiron24-app-install.pdf` (rendered by `scripts/render_pwa_install_pdf.py`)
- Owner email → League Tools → Communications → **Send app install guide**

## When steps change (Safari / Chrome / URLs)

1. Edit `pwa-install-guide.js` (Apple steps, Android steps, tips, URLs).
2. Regenerate the PDF (needs Python 3 + Pillow):

```bash
npm run docs:pwa-pdf
```

3. Commit both the JS and the PDF, then deploy.

## Sending to members

League Tools → **Communications** → **Send app install guide**  
Or share:

- https://www.gridiron24.com/install-app.html  
- https://www.gridiron24.com/docs/gridiron24-app-install.pdf  
