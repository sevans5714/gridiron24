# Keeping the PWA install guide up to date

**Single source of truth:** [`pwa-install-guide.js`](../pwa-install-guide.js)

That file drives:

- Web page → `/install-app.html`
- PDF → `/docs/gridiron24-app-install.pdf`
- Owner email → League Tools → Communications → **Send app install guide**

## When steps change (Safari / Chrome / URLs)

1. Edit `pwa-install-guide.js` (Apple steps, Android steps, tips, URLs).
2. Regenerate the PDF:

```bash
npm run docs:pwa-pdf
```

3. Commit both the JS and the PDF:

```bash
git add pwa-install-guide.js public/docs/gridiron24-app-install.pdf public/install-app.html
git commit -m "Update PWA install guide"
```

4. Deploy (push `main`).

## Sending to members

League Tools → **Communications** → **Send app install guide**  
Or share:

- https://www.gridiron24.com/install-app.html  
- https://www.gridiron24.com/docs/gridiron24-app-install.pdf  

Toggle / edit the email copy under **Communications → Auto messages → PWA install guide**.
