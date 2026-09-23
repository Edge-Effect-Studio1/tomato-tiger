'use strict';
// Admin aggregation view: total acres and delivered volume, grouped by crop and by supplier (buyer/
// exporter). Deliberately server-side and over EVERY row, not the paginated list the admin page loads
// 100-at-a-time - summing only what happens to be loaded client-side would silently under-count once
// there are more than 100 submissions. Same Bearer-password auth as api/submissions.js (duplicated
// here rather than shared, matching this project's existing one-file-per-endpoint convention).
const { sql } = require('@vercel/postgres');
const crypto = require('crypto');

const digest = s => crypto.createHash('sha256').update(String(s)).digest();
function checkAuth(req) {
  const expected = (process.env.ADMIN_PASSWORD || '').trim();
  if (!expected) return 'unconfigured';
  const header = String(req.headers['authorization'] || '');
  const given = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return crypto.timingSafeEqual(digest(given), digest(expected)) ? 'ok' : 'denied';
}

// Buyer/supplier is free text a grower typed, not a controlled field like crop - "Super Soy",
// "super soy " and "Super Soy Inc" would otherwise land as three separate rows. Grouped on a
// trimmed/lowercased key; the displayed label is whichever original spelling appeared most often
// for that key, so a typo'd minority variant doesn't become the label growers and Robbe both see.
function supplierKey(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }
  const auth = checkAuth(req);
  if (auth === 'unconfigured') {
    res.status(503).json({ ok: false, error: 'admin password is not configured' });
    return;
  }
  if (auth !== 'ok') {
    res.status(401).json({ ok: false, error: 'wrong password' });
    return;
  }
  try {
    const rows = (await sql`
      SELECT
        left(bundle->'answers'->'cropsoil'->>'crop', 60) AS crop,
        left(bundle->>'buyer', 200) AS buyer,
        bundle->'boundary'->>'acres' AS acres,
        bundle->'answers'->'farm'->'delivered'->>'amount' AS delivered_amount,
        left(bundle->'answers'->'farm'->'delivered'->>'unit', 20) AS delivered_unit
      FROM survey_submissions
    `.catch(err => {
      if (err && err.code === '42P01') return { rows: [] }; // table doesn't exist yet - nothing submitted
      throw err;
    })).rows;

    const byCrop = new Map();   // crop -> {acres, fields, volume: Map(unit -> amount), volumeFields}
    const byBuyer = new Map();  // key -> {label, labelCounts: Map, acres, fields, crops: Set, volume: Map, volumeFields}
    let noCrop = 0, noBuyer = 0, noBoundary = 0;

    const ensureCrop = c => {
      if (!byCrop.has(c)) byCrop.set(c, { acres: 0, fields: 0, volume: new Map(), volumeFields: 0 });
      return byCrop.get(c);
    };
    const ensureBuyer = key => {
      if (!byBuyer.has(key)) byBuyer.set(key, { labelCounts: new Map(), acres: 0, fields: 0, crops: new Set(), volume: new Map(), volumeFields: 0 });
      return byBuyer.get(key);
    };

    for (const r of rows) {
      const crop = (r.crop || '').trim();
      const buyerRaw = (r.buyer || '').trim();
      const key = supplierKey(buyerRaw);
      const acres = Number(r.acres);
      const hasAcres = Number.isFinite(acres) && acres > 0;
      const delAmt = Number(r.delivered_amount);
      const hasDelivered = Number.isFinite(delAmt) && delAmt > 0 && r.delivered_unit;

      if (crop) {
        const c = ensureCrop(crop);
        c.fields++;
        if (hasAcres) c.acres += acres;
        if (hasDelivered) { c.volume.set(r.delivered_unit, (c.volume.get(r.delivered_unit) || 0) + delAmt); c.volumeFields++; }
      } else noCrop++;

      if (key) {
        const b = ensureBuyer(key);
        b.labelCounts.set(buyerRaw, (b.labelCounts.get(buyerRaw) || 0) + 1);
        b.fields++;
        if (hasAcres) b.acres += acres;
        if (crop) b.crops.add(crop);
        if (hasDelivered) { b.volume.set(r.delivered_unit, (b.volume.get(r.delivered_unit) || 0) + delAmt); b.volumeFields++; }
      } else noBuyer++;

      if (!hasAcres) noBoundary++;
    }

    const mapToVolumeArray = m => [...m.entries()].map(([unit, amount]) => ({ unit, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
    const byCropOut = [...byCrop.entries()]
      .map(([crop, v]) => ({ crop, acres: Math.round(v.acres * 100) / 100, fields: v.fields, volume: mapToVolumeArray(v.volume), volumeFields: v.volumeFields }))
      .sort((a, b) => b.acres - a.acres);
    const byBuyerOut = [...byBuyer.entries()]
      .map(([, v]) => {
        const label = [...v.labelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        return { supplier: label, acres: Math.round(v.acres * 100) / 100, fields: v.fields, crops: [...v.crops].sort(), volume: mapToVolumeArray(v.volume), volumeFields: v.volumeFields };
      })
      .sort((a, b) => b.acres - a.acres);

    res.status(200).json({
      ok: true,
      totalSubmissions: rows.length,
      noCrop, noBuyer, noBoundary,
      byCrop: byCropOut,
      bySupplier: byBuyerOut,
    });
  } catch (err) {
    console.error('dashboard failed:', err);
    res.status(500).json({ ok: false, error: 'could not build dashboard' });
  }
};
