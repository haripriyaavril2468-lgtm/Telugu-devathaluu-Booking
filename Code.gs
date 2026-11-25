/****************************************************************************
 * Telugu Devathaluu – Booking backend (Google Apps Script)
 *
 * What it does
 *  - Tells the website which dates/slots are free (3 slots a day)
 *  - Holds a slot for 12 minutes while the client pays (Razorpay)
 *  - Verifies the payment, locks the slot, emails a PDF receipt,
 *    adds the session to your Google Calendar
 *  - Custom-time requests: you approve/decline in the Sheet;
 *    approval sends the client a Razorpay payment link
 *  - Every 5 minutes it re-checks Razorpay so a paid booking is never lost
 *
 * Setup (once)
 *  1. Use a NEW Google Sheet → Extensions → Apps Script → paste this file.
 *  2. Project Settings → Script properties → add:
 *       RZP_KEY_ID      (from Razorpay → Account & Settings → API keys)
 *       RZP_KEY_SECRET  (keep secret – never put it in GitHub)
 *  3. Run the function `setup` once and allow the permissions.
 *  4. Deploy → New deployment → Web app → Execute as: Me,
 *     Who has access: Anyone → copy the Web app URL into index.html.
 ****************************************************************************/

const TZ = 'Asia/Kolkata';
const BUSINESS_NAME = 'Telugu Devathaluu';
const WHATSAPP = '919110758372';

// Prices are decided HERE only – the website cannot change them.
const SERVICES = {
  vedic: { name: 'Vedic Astrology', amount: 1500 },
  combo: { name: 'Vedic Astrology + Tarot', amount: 2500 },
  tarot: { name: 'Tarot Card Reading', amount: 1000 },
};

const SLOTS = [
  { id: '11:00', label: '11:00 AM' },
  { id: '17:00', label: '5:00 PM' },
  { id: '19:30', label: '7:30 PM' },
];

const SESSION_MINUTES = 90;  // 1 hr 30 min
const DURATION_TEXT = '1 hour 30 minutes (may extend by 20–30 minutes if your questions need more time)';
const HOLD_MINUTES = 12;      // Razorpay popup closes at 10 min, +2 min grace
const MIN_NOTICE_HOURS = 1;   // a slot can't be booked less than 1 h before it starts
const BOOK_AHEAD_DAYS = 30;   // how far ahead clients can book
const LINK_VALID_HOURS = 48;
const MODE_TEXT = 'WhatsApp voice call';
const RESCHEDULE_TEXT = 'Rescheduling is free – please inform us at least 1 day before (minimum 5 hours before your session). Cancel any time before your session for a full refund.';  // payment link for approved custom requests

const HEADERS = ['ReceiptNo', 'Created', 'Date', 'Slot', 'Service', 'Amount',
  'Name', 'Phone', 'Email', 'BirthDate', 'BirthTime', 'BirthPlace', 'Question',
  'Status', 'OrderId', 'PaymentId', 'HoldUntil', 'PayLinkId', 'PayLink', 'Notes'];

const STATUSES = ['HOLD', 'PAID', 'EXPIRED', 'REFUND_NEEDED', 'REFUNDED',
  'PENDING', 'APPROVED', 'AWAITING_PAYMENT', 'DECLINED', 'CANCELLED'];

const REFUND_MSG = 'Sorry – this slot was taken by someone else while you were paying. ' +
  'Your payment is safe and will be refunded, or we will offer you another slot. ' +
  'Please message us on WhatsApp.';

/* ======================= Web endpoints ======================= */

function doGet(e) {
  return respond(() => {
    const p = (e && e.parameter) || {};
    if (p.action === 'month') return getMonth(p.ym);
    if (p.action === 'ping') return { ok: true };
    throw new Error('Unknown action');
  });
}

function doPost(e) {
  return respond(() => {
    const b = JSON.parse(e.postData.contents || '{}');
    switch (b.action) {
      case 'hold': return hold(b);
      case 'confirm': return confirmPayment(b);
      case 'release': return release(b);
      case 'request': return requestCustom(b);
    }
    throw new Error('Unknown action');
  });
}

function respond(fn) {
  let out;
  try { out = fn(); } catch (err) {
    console.error(err);
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ======================= Availability ======================= */

function getMonth(ym) {
  if (!/^\d{4}-\d{2}$/.test(String(ym))) throw new Error('Bad month');
  const now = Date.now();
  const taken = takenMap(readRows(), now);
  const blocked = blockRules();
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = {};
  for (let d = 1; d <= daysInMonth; d++) {
    const ymd = `${y}-${pad(m)}-${pad(d)}`;
    days[ymd] = SLOTS.filter(s => !isBlocked(blocked, ymd, s.id) && bookableTime(ymd, s.id, now) &&
      !(taken[ymd] && taken[ymd][s.id])).map(s => s.id);
  }
  // Only free slot ids are returned – never other clients' details.
  return { ok: true, days };
}

function bookableTime(ymd, slotId, now) {
  const t = slotStart(ymd, slotId).getTime();
  return t > now + MIN_NOTICE_HOURS * 36e5 && t < now + BOOK_AHEAD_DAYS * 864e5;
}

/* ======================= Booking flow ======================= */

function hold(b) {
  const svc = SERVICES[b.service];
  if (!svc) throw new Error('Please choose a service.');
  const slot = SLOTS.find(s => s.id === b.slot);
  if (!slot) throw new Error('Please choose a time slot.');
  const ymd = toYmd(b.date);
  const c = validateClient(b);

  return withLock(() => {
    const now = Date.now();
    const rows = readRows();
    if (!bookableTime(ymd, slot.id, now)) throw new Error('This slot can no longer be booked.');
    if (isBlocked(blockRules(), ymd, slot.id)) throw new Error('This slot is not available.');
    const taken = takenMap(rows, now);
    if (taken[ymd] && taken[ymd][slot.id]) throw new Error('Sorry, this slot was just booked. Please choose another.');

    // One active hold per phone number (stops one person blocking many slots)
    rows.filter(r => r.Status === 'HOLD' && String(r.Phone) === c.Phone && Number(r.HoldUntil) > now)
      .forEach(r => updateRow(r._row, { Status: 'EXPIRED', Notes: 'Replaced by a newer hold' }));

    const order = rzp('post', '/orders', {
      amount: svc.amount * 100, currency: 'INR', receipt: 'H' + now,
      notes: { date: ymd, slot: slot.label, service: svc.name, phone: c.Phone },
    });

    appendRow(Object.assign({
      Created: fmtNow(), Date: ymd, Slot: slot.id, Service: svc.name, Amount: svc.amount,
      Status: 'HOLD', OrderId: order.id, HoldUntil: String(now + HOLD_MINUTES * 6e4),
    }, c));

    return { ok: true, orderId: order.id, amount: svc.amount * 100, keyId: prop('RZP_KEY_ID'),
      service: svc.name, slotLabel: slot.label, dateLabel: prettyDate(ymd), phone: c.Phone };
  });
}

function confirmPayment(b) {
  const orderId = String(b.razorpay_order_id || '');
  const paymentId = String(b.razorpay_payment_id || '');
  const sig = String(b.razorpay_signature || '');
  // Signature check: proves the payment really came from Razorpay for this order.
  if (!orderId || !paymentId || hmacHex(orderId + '|' + paymentId, prop('RZP_KEY_SECRET')) !== sig) {
    throw new Error('Payment could not be verified. If money was deducted, please message us on WhatsApp.');
  }
  try { paidPayment(orderId); } catch (e) { console.error(e); } // capture if not auto-captured
  return finalizeOrder(orderId, paymentId);
}

function release(b) {
  const orderId = String(b.orderId || '');
  return withLock(() => {
    const r = readRows().find(x => x.OrderId === orderId);
    if (!r || r.Status !== 'HOLD') return { ok: true };
    if (paidPayment(orderId)) return { ok: true }; // paid after all – reconcile will finish it
    updateRow(r._row, { Status: 'EXPIRED', Notes: 'Checkout closed' });
    return { ok: true };
  });
}

function finalizeOrder(orderId, paymentId) {
  return withLock(() => {
    const r = readRows().find(x => x.OrderId === orderId);
    if (!r) throw new Error('Booking not found. Please message us on WhatsApp.');
    return finalizeRow(r, paymentId);
  });
}

// Must be called inside withLock
function finalizeRow(r, paymentId) {
  if (r.Status === 'PAID') return receiptInfo(r);
  if (r.Status === 'REFUND_NEEDED') return { ok: false, error: REFUND_MSG };
  const now = Date.now();
  const ymd = toYmd(r.Date);
  const clash = readRows().some(x => x._row !== r._row && toYmd(x.Date) === ymd &&
    normSlot(x.Slot) === normSlot(r.Slot) && isActive(x, now));
  if (clash) {
    updateRow(r._row, { Status: 'REFUND_NEEDED', PaymentId: paymentId,
      Notes: 'Slot taken while paying – refund in Razorpay or offer another slot' });
    notifyOwner('⚠️ Refund needed – ' + r.Name,
      `${esc(r.Name)} (${esc(r.Phone)}) paid ₹${r.Amount} for ${prettyDate(ymd)} ${slotLabel(r)}, ` +
      `but the slot was already taken. Payment ID: ${esc(paymentId)}. ` +
      'Refund it from the Razorpay dashboard or offer another slot.');
    return { ok: false, error: REFUND_MSG };
  }
  return markPaid(r, paymentId);
}

function markPaid(r, paymentId) {
  const no = nextReceiptNo();
  updateRow(r._row, { Status: 'PAID', PaymentId: paymentId, ReceiptNo: no });
  Object.assign(r, { Status: 'PAID', PaymentId: paymentId, ReceiptNo: no });
  try { sendReceipt(r); } catch (e) { console.error(e); }
  try { addToCalendar(r); } catch (e) { console.error(e); }
  return receiptInfo(r);
}

/* ======================= Custom-time requests ======================= */

function requestCustom(b) {
  const svc = SERVICES[b.service];
  if (!svc) throw new Error('Please choose a service.');
  const ymd = toYmd(b.date);
  const time = String(b.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Please choose a date and time.');
  if (slotStart(ymd, time).getTime() < Date.now() + MIN_NOTICE_HOURS * 36e5) throw new Error('Please choose a later time.');
  const c = validateClient(b);

  return withLock(() => {
    if (readRows().some(r => String(r.Phone) === c.Phone && r.Status === 'PENDING')) {
      throw new Error('You already have a request waiting for approval. We will contact you soon.');
    }
    appendRow(Object.assign({ Created: fmtNow(), Date: ymd, Slot: time, Service: svc.name,
      Amount: svc.amount, Status: 'PENDING' }, c));
    notifyOwner('New custom time request – ' + c.Name,
      `${esc(c.Name)} (+${esc(c.Phone)}) wants ${esc(svc.name)} on ${prettyDate(ymd)} at ${timeLabel(ymd, time)}.<br>` +
      'Open the Bookings sheet and change Status to <b>APPROVED</b> or <b>DECLINED</b>.');
    return { ok: true };
  });
}

// Installable trigger (created by setup): reacts when you change Status in the sheet
function onBookingEdit(e) {
  const sh = e.range.getSheet();
  if (sh.getName() !== 'Bookings' || e.range.getNumRows() !== 1) return;
  if (e.range.getColumn() !== HEADERS.indexOf('Status') + 1) return;
  const v = String(e.value || '').trim().toUpperCase();
  const r = readRows().find(x => x._row === e.range.getRow());
  if (!r) return;
  if (v === 'APPROVED') approveCustom(r);
  if (v === 'DECLINED') declineCustom(r);
}

function approveCustom(r) {
  withLock(() => {
    if (r.PaymentId || r.PayLinkId) return;
    const now = Date.now();
    const ymd = toYmd(r.Date);
    const clash = readRows().some(x => x._row !== r._row && toYmd(x.Date) === ymd &&
      normSlot(x.Slot) === normSlot(r.Slot) && isActive(x, now));
    if (clash) {
      updateRow(r._row, { Status: 'PENDING', Notes: 'Cannot approve: this time is already booked' });
      return;
    }
    const expire = now + LINK_VALID_HOURS * 36e5;
    const link = rzp('post', '/payment_links', {
      amount: Number(r.Amount) * 100, currency: 'INR',
      description: `${r.Service} – ${prettyDate(ymd)} ${slotLabel(r)} IST (1 hr 30 min)`,
      customer: { name: r.Name, email: r.Email, contact: '+' + r.Phone },
      notify: { sms: true, email: true }, reminder_enable: true,
      expire_by: Math.floor(expire / 1000),
    });
    updateRow(r._row, { Status: 'AWAITING_PAYMENT', PayLinkId: link.id, PayLink: link.short_url,
      HoldUntil: String(expire), Notes: 'Payment link sent' });
    MailApp.sendEmail({
      to: r.Email, name: BUSINESS_NAME, replyTo: ownerEmail(),
      subject: 'Your consultation time is approved – please complete payment',
      htmlBody: `Namaste ${esc(r.Name)},<br><br>Your requested time <b>${prettyDate(ymd)}, ${slotLabel(r)} IST</b> ` +
        `for <b>${esc(r.Service)}</b> is approved.<br>Please pay ₹${r.Amount} within ${LINK_VALID_HOURS} hours to confirm:<br>` +
        `<a href="${link.short_url}">${link.short_url}</a><br><br>${BUSINESS_NAME}`,
    });
  });
}

function declineCustom(r) {
  if (!r.Email) return;
  MailApp.sendEmail({
    to: r.Email, name: BUSINESS_NAME, replyTo: ownerEmail(),
    subject: 'About your consultation request',
    htmlBody: `Namaste ${esc(r.Name)},<br><br>Sorry, the time you requested (${prettyDate(toYmd(r.Date))}, ` +
      `${slotLabel(r)} IST) is not available. Please choose one of the open slots on our website or ` +
      `message us on WhatsApp: <a href="https://wa.me/${WHATSAPP}">+${WHATSAPP}</a>.<br><br>${BUSINESS_NAME}`,
  });
}

/* ======================= Safety net (every 5 minutes) ======================= */

function reconcile() {
  const now = Date.now();
  readRows().forEach(r => {
    try {
      // Paid but the browser closed before confirming → finish the booking
      if ((r.Status === 'HOLD' || r.Status === 'EXPIRED') && r.OrderId && !r.PaymentId &&
          now - Number(r.HoldUntil) < 48 * 36e5) {
        const p = paidPayment(r.OrderId);
        if (p) finalizeOrder(r.OrderId, p.id);
        else if (r.Status === 'HOLD' && Number(r.HoldUntil) < now) updateRow(r._row, { Status: 'EXPIRED' });
      }
      // Approved custom request: was the payment link paid?
      if (r.Status === 'AWAITING_PAYMENT' && r.PayLinkId) {
        const l = rzp('get', '/payment_links/' + r.PayLinkId);
        if (l.status === 'paid') {
          const pid = (l.payments && l.payments[0] && l.payments[0].payment_id) || r.PayLinkId;
          withLock(() => finalizeRow(r, pid));
        } else if (l.status === 'expired' || l.status === 'cancelled') {
          updateRow(r._row, { Status: 'EXPIRED', Notes: 'Payment link ' + l.status });
        }
      }
    } catch (e) { console.error('Row ' + r._row + ': ' + e); }
  });
}

/* ======================= Receipt, email, calendar ======================= */

function receiptInfo(r) {
  return { ok: true, receiptNo: r.ReceiptNo, name: r.Name, service: r.Service, amount: Number(r.Amount),
    dateLabel: prettyDate(toYmd(r.Date)), slotLabel: slotLabel(r), paymentId: r.PaymentId, phone: String(r.Phone) };
}

function receiptHtml(r) {
  const row = (k, v) => `<tr><td style="padding:6px 10px;color:#7a1f1f">${k}</td><td style="padding:6px 10px"><b>${v}</b></td></tr>`;
  return `<div style="font-family:Georgia,serif;max-width:520px;border:3px double #c9a227;padding:24px;background:#fffaf0">
    <h2 style="color:#7a1f1f;text-align:center;margin:0">${BUSINESS_NAME}</h2>
    <p style="text-align:center;margin:4px 0 16px">Vedic Astrology &amp; Tarot Consultations<br><b>PAYMENT RECEIPT</b></p>
    <table style="width:100%;border-collapse:collapse">
      ${row('Receipt No', esc(r.ReceiptNo))}
      ${row('Issued on', fmtNow())}
      ${row('Client', esc(r.Name))}
      ${row('Phone', '+' + esc(r.Phone))}
      ${row('Service', esc(r.Service))}
      ${row('Session', prettyDate(toYmd(r.Date)) + ', ' + slotLabel(r) + ' IST')}
      ${row('Duration', DURATION_TEXT)}
      ${row('Mode', MODE_TEXT + ' – we will call you on +' + esc(r.Phone))}
      ${row('Amount paid', '₹' + Number(r.Amount).toLocaleString('en-IN'))}
      ${row('Payment ID', esc(r.PaymentId))}
    </table>
    <p style="font-size:12px;color:#555;margin-top:16px">${RESCHEDULE_TEXT}<br>
    This is a payment receipt, not a tax invoice. For questions, WhatsApp +${WHATSAPP}.</p></div>`;
}

function sendReceipt(r) {
  const html = receiptHtml(r);
  const pdf = Utilities.newBlob(html, 'text/html', 'receipt.html')
    .getAs('application/pdf').setName(`Receipt-${r.ReceiptNo}.pdf`);
  MailApp.sendEmail({
    to: r.Email, name: BUSINESS_NAME, replyTo: ownerEmail(),
    subject: `Booking confirmed – ${prettyDate(toYmd(r.Date))}, ${slotLabel(r)} IST`,
    htmlBody: `Namaste ${esc(r.Name)},<br><br>Your consultation is confirmed. Your receipt is attached.<br>` +
      `We will call you on <b>WhatsApp voice call (+${esc(r.Phone)})</b> at your session time – please be available on time.<br><br>${html}` +
      `<br>Questions? WhatsApp us: <a href="https://wa.me/${WHATSAPP}">+${WHATSAPP}</a>`,
    attachments: [pdf],
  });
  // Your alert: one tap opens a WhatsApp chat with the client
  const hello = `Namaste ${r.Name} garu 🙏 This is Telugu Devathaluu. Thank you for booking ${r.Service} on ` +
    `${prettyDate(toYmd(r.Date))} at ${slotLabel(r)} IST (Receipt ${r.ReceiptNo}). I will call you on WhatsApp at that time. The session is 1 hour 30 minutes.`;
  const waClient = `https://wa.me/${r.Phone}?text=${encodeURIComponent(hello)}`;
  notifyOwner(`✅ New booking ${r.ReceiptNo} – ${r.Name} – +${r.Phone}`,
    `<p><a href="${waClient}" style="background:#25D366;color:#fff;padding:12px 18px;border-radius:8px;` +
    `text-decoration:none;font-weight:bold">📲 Chat with ${esc(r.Name)} on WhatsApp</a></p>` + html);
}

function addToCalendar(r) {
  const start = slotStart(toYmd(r.Date), normSlot(r.Slot));
  const end = new Date(start.getTime() + SESSION_MINUTES * 6e4);
  CalendarApp.getDefaultCalendar().createEvent(`${r.Service}: ${r.Name}`, start, end, {
    description: `Receipt ${r.ReceiptNo}\n1 hr 30 min (can extend 20–30 min)\nPhone: +${r.Phone}\nEmail: ${r.Email}\n` +
      `Birth: ${r.BirthDate} ${r.BirthTime}, ${r.BirthPlace}\nQuestion: ${r.Question}`,
  });
}

function notifyOwner(subject, html) {
  MailApp.sendEmail({ to: ownerEmail(), subject, htmlBody: html, name: BUSINESS_NAME + ' Bookings' });
}

function ownerEmail() {
  return PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || Session.getEffectiveUser().getEmail();
}

/* ======================= Razorpay ======================= */

function rzp(method, path, payload) {
  const auth = Utilities.base64Encode(prop('RZP_KEY_ID') + ':' + prop('RZP_KEY_SECRET'));
  const opt = { method, headers: { Authorization: 'Basic ' + auth }, muteHttpExceptions: true, contentType: 'application/json' };
  if (payload) opt.payload = JSON.stringify(payload);
  const res = UrlFetchApp.fetch('https://api.razorpay.com/v1' + path, opt);
  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() >= 300) {
    throw new Error('Payment service error: ' + ((body.error && body.error.description) || res.getResponseCode()));
  }
  return body;
}

// Returns the successful payment for an order (captures it if only authorized)
function paidPayment(orderId) {
  const items = rzp('get', '/orders/' + orderId + '/payments').items || [];
  let p = items.find(x => x.status === 'captured');
  if (p) return p;
  p = items.find(x => x.status === 'authorized');
  if (p) { rzp('post', '/payments/' + p.id + '/capture', { amount: p.amount, currency: p.currency }); return p; }
  return null;
}

function hmacHex(msg, key) {
  return Utilities.computeHmacSha256Signature(msg, key)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}

/* ======================= Sheet helpers ======================= */

function sheet(name) { return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }

function readRows() {
  const values = sheet('Bookings').getDataRange().getValues();
  const head = values[0];
  return values.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { o[h] = r[j]; });
    o.Phone = String(o.Phone || '');
    o.OrderId = String(o.OrderId || '');
    return o;
  });
}

function updateRow(rowNum, patch) {
  const sh = sheet('Bookings');
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Object.keys(patch).forEach(k => {
    const c = head.indexOf(k);
    if (c >= 0) sh.getRange(rowNum, c + 1).setValue(patch[k]);
  });
}

function appendRow(obj) {
  sheet('Bookings').appendRow(HEADERS.map(h => (obj[h] === undefined ? '' : obj[h])));
}

/* Blocked tab – you control your days off:
 *   Column A: a date (25/12/2026)  OR  a weekday (Tuesday) for every week
 *   Column B: "Whole day" (or blank)  OR  one slot: 11:00 AM / 5:00 PM / 7:30 PM
 *   Column C: reason (only for you) – e.g. Amavasya
 */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function blockRules() {
  const values = sheet('Blocked').getDataRange().getValues().slice(1);
  const rules = new Set();
  values.forEach(r => {
    if (r[0] === '' || r[0] === null) return;
    const a = String(r[0]).trim().toLowerCase();
    const wd = WEEKDAYS.find(w => w.startsWith(a.slice(0, 3)) && a.length >= 3 && /^[a-z]+$/.test(a));
    const key = wd || toYmd(r[0]);
    rules.add(key + '|' + blockSlot(r[1]));
  });
  return rules;
}

function blockSlot(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s || s.startsWith('whole') || s === 'all') return 'all';
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return 'all';
  let h = Number(m[1]);
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (!m[3] && h < 9) h += 12;               // "5" or "7:30" means evening
  return pad(h) + ':' + (m[2] || '00');
}

function isBlocked(rules, ymd, slotId) {
  const wd = WEEKDAYS[Utilities.parseDate(ymd, TZ, 'yyyy-MM-dd').getDay()];
  return [ymd, wd].some(k => rules.has(k + '|all') || rules.has(k + '|' + slotId));
}

function isActive(r, now) {
  return r.Status === 'PAID' ||
    ((r.Status === 'HOLD' || r.Status === 'AWAITING_PAYMENT') && Number(r.HoldUntil) > now);
}

function takenMap(rows, now) {
  const m = {};
  rows.forEach(r => {
    if (!isActive(r, now)) return;
    const d = toYmd(r.Date);
    (m[d] = m[d] || {})[normSlot(r.Slot)] = true;
  });
  return m;
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nextReceiptNo() {
  const p = PropertiesService.getScriptProperties();
  const n = Number(p.getProperty('RECEIPT_SEQ') || 0) + 1;
  p.setProperty('RECEIPT_SEQ', String(n));
  return 'TD-' + ('000' + n).slice(-4);
}

function prop(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  if (!v) throw new Error('Setup incomplete: missing script property ' + k);
  return v;
}

/* ======================= Small utilities ======================= */

function validateClient(b) {
  let phone = String(b.phone || '').replace(/\D/g, '');
  if (phone.length === 10) phone = '91' + phone;          // Indian number without +91
  const c = {
    Name: clean(b.name, 80), Phone: phone, Email: clean(b.email, 100),
    BirthDate: clean(b.birthDate, 20), BirthTime: clean(b.birthTime, 20),
    BirthPlace: clean(b.birthPlace, 80), Question: clean(b.question, 500),
  };
  if (!c.Name) throw new Error('Please enter your name.');
  if (phone.length < 11 || phone.length > 15) throw new Error('Please enter a valid WhatsApp number.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.Email)) throw new Error('Please enter a valid email address.');
  return c;
}

// strips HTML and anything that could become a spreadsheet formula
function clean(s, max) {
  return String(s || '').replace(/[<>]/g, '').trim().replace(/^[=+\-@]+/, '').slice(0, max || 100);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function pad(n) { return ('0' + n).slice(-2); }

function toYmd(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);   // dd/mm/yyyy
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return s;
}

function normSlot(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  const m = String(v || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad(m[1])}:${m[2]}` : String(v || '');
}

function slotStart(ymd, hhmm) { return Utilities.parseDate(`${ymd} ${hhmm}`, TZ, 'yyyy-MM-dd HH:mm'); }
function timeLabel(ymd, hhmm) { return Utilities.formatDate(slotStart(ymd, hhmm), TZ, 'h:mm a'); }
function slotLabel(r) { return timeLabel(toYmd(r.Date), normSlot(r.Slot)); }
function prettyDate(ymd) { return Utilities.formatDate(Utilities.parseDate(ymd, TZ, 'yyyy-MM-dd'), TZ, 'EEE, d MMM yyyy'); }
function fmtNow() { return Utilities.formatDate(new Date(), TZ, 'dd-MM-yyyy HH:mm'); }

/* ======================= One-time setup ======================= */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);

  const b = ss.getSheetByName('Bookings') || ss.insertSheet('Bookings');
  if (b.getLastRow() === 0) {
    b.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#f3e2b3');
    b.setFrozenRows(1);
  }
  b.getRange(2, 1, b.getMaxRows() - 1, HEADERS.length).setNumberFormat('@'); // keep everything as plain text
  b.getRange(2, HEADERS.indexOf('Status') + 1, b.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(true).build());

  ss.setSpreadsheetLocale('en_IN');   // so 25/12/2026 is read as 25 December
  const bl = ss.getSheetByName('Blocked') || ss.insertSheet('Blocked');
  if (bl.getLastRow() === 0) {
    bl.getRange(1, 1, 1, 3).setValues([['Date (dd/mm/yyyy) or Weekday', 'Slot', 'Reason']])
      .setFontWeight('bold').setBackground('#f3e2b3');
    bl.setFrozenRows(1);
    bl.getRange(2, 1, 2, 3).setValues([['Tuesday', 'Whole day', 'Example – delete if not needed'],
      ['', '', '']]);
    bl.setColumnWidth(1, 220); bl.setColumnWidth(3, 260);
  }
  bl.getRange(2, 2, bl.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Whole day', '11:00 AM', '5:00 PM', '7:30 PM'], true).setAllowInvalid(true).build());

  ScriptApp.getProjectTriggers().forEach(t => {
    if (['reconcile', 'onBookingEdit'].includes(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('reconcile').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('onBookingEdit').forSpreadsheet(ss).onEdit().create();

  // Touch services so Google asks for all permissions now
  CalendarApp.getDefaultCalendar();
  MailApp.getRemainingDailyQuota();
  UrlFetchApp.getRequest('https://api.razorpay.com/v1/');
  return 'Setup done';
}
