// Placeholder so the browser does not log a 404 for this request.
//
// The app references <script src="webxdc.js"> per the webxdc specification: a
// messenger serving this app intercepts the request and returns its own API
// implementation, which defines window.webxdc. In a plain browser nothing
// intercepts it, this empty file loads instead, and the app falls back to
// downloading the .xdc (see exportXdc).
