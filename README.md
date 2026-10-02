# Wedding photo share

Guest photo page for Kiley and Ian's wedding (October 10, 2026). Guests scan a QR code, add photos from their phone, and browse the shared album.

- `/` add photos, and a button through to the album
- `/#photos` the shared album
- `/sign` printable 5x7 table sign with the QR code
- `/?host=KEY` turns on host mode on that device (remove photos, download all as a zip)

## Stack
Node + Express, Postgres. Fonts are self-hosted in `public/fonts`. Photos are resized in the browser (2000px full, 480px thumbnail) and stored in the database.

## Environment
- `DATABASE_URL` Postgres connection string (Render: the Internal Database URL of `wedding-photos-db`)
- `HOST_KEY` secret for host mode
- `MAX_DB_MB` optional, uploads stop past this database size (default 900)
- `SITE_URL` optional, overrides the address the QR code points to

## Run
`npm install && DATABASE_URL=... HOST_KEY=... npm start`
