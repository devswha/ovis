### Fixed
- A JPEG or HEIC photo is shrunk to at most 2048 pixels a side before it uploads, so it uploads
  much faster, and its location, device and date are dropped on the way. A JPEG the browser
  cannot draw has its Exif, XMP and IPTC cut out but for its orientation, and a HEIC one still
  uploads as it is.
