'use strict';

// ═══════════════════════════════════════════════════════════════
// SariPrice Push Server
//
// ENV VARS (Render → Environment):
//   FIREBASE_SERVICE_ACCOUNT  (required) — buong JSON ng service account
//   RENDER_EXTERNAL_URL       (awtomatikong nilalagay ng Render) — para sa keep-alive
//   CATCHUP_MINUTES           (optional, default 180) — hanggang ilang minuto pabalik
//                             ang hahabulin na events kapag nag-restart/nag-wake ang server
//   KEEP_ALIVE_MINUTES        (optional, default 10)
//
// ⚠️ Dapat tugma ang mga constants sa ibaba (ANDROID_CHANNEL_ID, NOTIF_TYPE,
//    FCM data keys) sa push_notification_service.dart ng app.
// ═══════════════════════════════════════════════════════════════

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const express = require('express');

// ───────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────
const CATCHUP_MINUTES = Number(process.env.CATCHUP_MINUTES) || 180;
const KEEP_ALIVE_MINUTES = Number(process.env.KEEP_ALIVE_MINUTES) || 10;
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '';
const LOG_TTL_DAYS = 30; // gaano katagal itatabi ang push_log (para sa dedupe)

// ✅ Tugma sa Flutter app (PushNotificationService)
const STAFF_ROLE = 'staff'; // lowercase dahil lowercase rin ang nilalagay sa `role` sa ibaba
const ANDROID_CHANNEL_ID = 'sariprice_channel';
const NOTIF_TYPE = {
  NEW_PRODUCT: 'new_product',
  PRICE_UPDATE: 'price_update',
  NEW_BUNDLE: 'new_bundle',
  BUNDLE_PRICE: 'bundle_price',
};

// ───────────────────────────────────────────────────────────────
// FIREBASE INIT
// ───────────────────────────────────────────────────────────────
function loadServiceAccount() {
  // ✅ PRODUCTION (Render): load from env var
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      // Minsan nagiging literal "\n" ang newlines ng private_key kapag na-paste sa env var
      if (typeof sa.private_key === 'string') {
        sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      }
      return sa;
    } catch (e) {
      console.error('FIREBASE_SERVICE_ACCOUNT ay hindi valid na JSON:', e.message);
      process.exit(1);
    }
  }

  // ✅ TESTING: load from file (kapag walang env var)
  try {
    return require('./service-account.json');
  } catch (e) {
    console.error('Walang FIREBASE_SERVICE_ACCOUNT env var at walang service-account.json.');
    process.exit(1);
  }
}

initializeApp({ credential: cert(loadServiceAccount()) });

const db = getFirestore();
const messaging = getMessaging();

// ───────────────────────────────────────────────────────────────
// SAFETY NETS — hindi dapat mamatay ang server dahil sa isang error
// ───────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// ───────────────────────────────────────────────────────────────
// STATE (para sa /health)
// ───────────────────────────────────────────────────────────────
const STARTED_AT = Date.now();
const listenerStatus = {};
const unsubscribers = {};
let lastNotificationAt = null;

// ───────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────
function cutoffTimestamp() {
  return Timestamp.fromMillis(Date.now() - CATCHUP_MINUTES * 60 * 1000);
}

// Isa-isa (serial) ang pagproseso ng events ng bawat listener
const chains = {};
function enqueue(name, fn) {
  chains[name] = (chains[name] || Promise.resolve())
    .then(fn)
    .catch((e) => console.error(`[${name}] handler error:`, e));
}

// Pakikinig sa Firestore na may auto-restart kapag nag-error
function listen(name, buildQuery, handleChange) {
  let retryMs = 5000;

  const start = () => {
    console.log(`[${name}] nakikinig...`);
    listenerStatus[name] = 'starting';

    unsubscribers[name] = buildQuery().onSnapshot(
      (snapshot) => {
        retryMs = 5000;
        listenerStatus[name] = 'ok';
        for (const change of snapshot.docChanges()) {
          enqueue(name, () => handleChange(change));
        }
      },
      (err) => {
        console.error(`[${name}] listener error: ${err.message}`);
        listenerStatus[name] = 'error';
        try { unsubscribers[name](); } catch (_) { /* ignore */ }
        setTimeout(start, retryMs);
        retryMs = Math.min(retryMs * 2, 60000);
      }
    );
  };

  start();
}

// ───────────────────────────────────────────────────────────────
// STAFF TOKENS
// ───────────────────────────────────────────────────────────────
// Case-insensitive ang role ("Staff", "staff", "STAFF"), at active lang ang kasama.
// Mga field na binabasa sa `users`: role, status, fcm_token
// (ang `fcm_token` ay sinusulat ng app sa PushNotificationService._saveToken)
async function getStaffTargets() {
  const usersSnap = await db.collection('users').get();

  const byToken = new Map();
  usersSnap.forEach((doc) => {
    const d = doc.data();
    const role = String(d.role || '').trim().toLowerCase();
    const status = String(d.status || 'active').trim().toLowerCase();
    const token = typeof d.fcm_token === 'string' ? d.fcm_token.trim() : '';

    if (role !== STAFF_ROLE || status !== 'active' || !token) return;

    if (!byToken.has(token)) byToken.set(token, []);
    byToken.get(token).push(doc.ref);
  });

  return Array.from(byToken, ([token, refs]) => ({ token, refs }));
}

// Tanggalin ang mga token na hindi na valid (uninstalled app, expired, atbp.)
async function removeDeadTokens(deadTargets) {
  for (const { token, refs } of deadTargets) {
    for (const ref of refs) {
      try {
        const snap = await ref.get();
        // Siguraduhing hindi pa napapalitan ng bago ang token bago burahin
        if (snap.exists && snap.data().fcm_token === token) {
          await ref.update({ fcm_token: FieldValue.delete() });
          console.log(`Inalis ang patay na token ng user ${ref.id}`);
        }
      } catch (e) {
        console.error('Hindi natanggal ang patay na token:', e.message);
      }
    }
  }
}

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

// ───────────────────────────────────────────────────────────────
// SEND
// ───────────────────────────────────────────────────────────────
async function notifyStaff(title, body, data = {}) {
  const targets = await getStaffTargets();
  if (targets.length === 0) {
    console.log('Walang Staff na may FCM token — skip');
    return 0;
  }

  // Kailangang string ang lahat ng values sa FCM "data"
  const stringData = {};
  for (const [k, v] of Object.entries(data)) stringData[k] = String(v);

  let sent = 0;

  // Hanggang 500 tokens lang kada tawag ng FCM
  for (let i = 0; i < targets.length; i += 500) {
    const chunk = targets.slice(i, i + 500);

    const response = await messaging.sendEachForMulticast({
      tokens: chunk.map((t) => t.token),
      notification: { title, body },
      data: stringData,
      // High priority para dumating agad kahit naka-Doze/background ang phone.
      // channelId ay dapat tugma sa channel na ginagawa ng app, para gamitin
      // ang importance/sound settings nito kapag background o killed ang app.
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: ANDROID_CHANNEL_ID },
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default' } },
      },
    });

    sent += response.successCount;

    const dead = [];
    response.responses.forEach((resp, idx) => {
      if (resp.success) return;
      const code = resp.error?.code;
      console.log(`Token ${idx} failed: ${code}`);
      if (DEAD_TOKEN_CODES.has(code)) dead.push(chunk[idx]);
    });
    await removeDeadTokens(dead);
  }

  lastNotificationAt = new Date().toISOString();
  return sent;
}

// ───────────────────────────────────────────────────────────────
// DEDUPE — para walang doble at walang flood
// Gumagamit ng "push_log" collection: isang doc kada notification.
// Ang create() ay mabibigo kapag umiiral na, kaya iisang instance lang
// (o isang pagkakataon lang) ang makakapagpadala — kahit dalawang server
// ang sabay na tumatakbo (hal. habang nagde-deploy sa Render).
// ───────────────────────────────────────────────────────────────
async function claim(key) {
  try {
    await db.collection('push_log').doc(key).create({
      created_at: FieldValue.serverTimestamp(),
      // I-enable ang Firestore TTL policy sa field na ito para kusang mabura
      expire_at: Timestamp.fromMillis(Date.now() + LOG_TTL_DAYS * 24 * 60 * 60 * 1000),
    });
    return true;
  } catch (e) {
    if (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message))) return false;
    throw e;
  }
}

async function release(key) {
  try {
    await db.collection('push_log').doc(key).delete();
  } catch (e) {
    console.error('Hindi na-release ang claim:', e.message);
  }
}

async function notifyOnce(key, title, body, data) {
  if (!(await claim(key))) return false; // naipadala na dati

  try {
    const sent = await notifyStaff(title, body, data);
    console.log(`[push] "${title}" → ${sent} device(s)`);
    return true;
  } catch (e) {
    console.error(`[push] nabigo ang "${title}":`, e.message);
    await release(key); // para ma-retry sa susunod na catch-up
    return false;
  }
}

async function getProductName(productId, fallback = 'Produkto') {
  if (!productId) return fallback;
  const doc = await db.collection('products').doc(productId).get();
  return doc.data()?.product_name || fallback;
}

// ═══════════════════════════════════════════════════════════════
// LISTENER 1: Bagong product
// Pinakikinggan lang ang products na ginawa sa loob ng CATCHUP window,
// kaya hindi binabasa ang buong collection at walang flood kapag nag-restart.
// Fields: products.created_at, products.product_name
// ═══════════════════════════════════════════════════════════════
listen(
  'products',
  () => db.collection('products').where('created_at', '>', cutoffTimestamp()),
  async (change) => {
    if (change.type !== 'added') return;

    const product = change.doc.data();
    const productName = product.product_name || 'Bagong produkto';

    await notifyOnce(
      `product_${change.doc.id}`,
      'New Product Available!',
      `A new ${productName} has been added to the shelf. Check it in SariPrice now!`,
      { type: NOTIF_TYPE.NEW_PRODUCT, productId: change.doc.id }
    );
  }
);

// ═══════════════════════════════════════════════════════════════
// LISTENER 2: Price Updates
// Fields: price_history.changed_at, old_price, new_price, product_id
// ═══════════════════════════════════════════════════════════════
listen(
  'price_history',
  () => db.collection('price_history').where('changed_at', '>', cutoffTimestamp()),
  async (change) => {
    if (change.type !== 'added') return;

    const data = change.doc.data();
    const oldPrice = Number(data.old_price) || 0;
    const newPrice = Number(data.new_price) || 0;

    if (oldPrice === newPrice) return;
    // Ang unang presyo ng bagong product (₱0 → ₱X) ay sakop na ng "New Product"
    if (oldPrice <= 0) return;

    const productId = data.product_id;
    const productName = await getProductName(productId);

    const isIncrease = newPrice > oldPrice;
    const title = isIncrease ? 'Price Increase Alert' : 'Price Decrease Alert';

    await notifyOnce(
      `price_${change.doc.id}`,
      title,
      `${productName}: ₱${oldPrice.toFixed(2)} → ₱${newPrice.toFixed(2)}`,
      { type: NOTIF_TYPE.PRICE_UPDATE, productId: productId || '' }
    );
  }
);

// ═══════════════════════════════════════════════════════════════
// LISTENER 3: Bundle Options
// Walang timestamp na mapagkakatiwalaan dito, kaya ikinukumpara ang
// kasalukuyang bundles sa huling nakitang bundles ("bundle_state" collection).
// - Unang beses na makita ang product → baseline lang (hindi mag-notify)
// - Nagbago ang bundles → mag-notify
// - Presyo lang ng product ang nagbago → walang notification
// Fields: prices/{productId}.pricing_options (o .bundles) — [{quantity|qty|pieces, price|bundle_price}]
// ═══════════════════════════════════════════════════════════════
function normalizeBundles(priceData) {
  const raw = priceData.pricing_options || priceData.bundles;
  if (!Array.isArray(raw)) return [];

  return raw.map((o) => {
    const qty = Number(o?.quantity ?? o?.qty ?? o?.pieces);
    const price = Number(o?.price ?? o?.bundle_price);
    const qtyOk = Number.isFinite(qty);
    return {
      id: qtyOk ? String(qty) : JSON.stringify(o ?? null),
      qty: qtyOk ? qty : null,
      price: Number.isFinite(price) ? price : null,
    };
  });
}

function fingerprint(opts) {
  return opts.map((o) => `${o.id}:${o.price}`).sort().join('|');
}

function describeBundle(o) {
  if (o.qty != null && o.price != null) return `${o.qty} pcs for ₱${o.price.toFixed(2)}`;
  if (o.qty != null) return `${o.qty} pcs`;
  return 'bundle';
}

// Atomic: iisang instance lang ang makakakita ng "changed"
async function diffBundleState(productId, opts, fp) {
  const ref = db.collection('bundle_state').doc(productId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const next = { fingerprint: fp, options: opts, updated_at: FieldValue.serverTimestamp() };

    if (!snap.exists) {
      tx.set(ref, next);
      return { type: 'baseline' };
    }
    const prev = snap.data();
    if (prev.fingerprint === fp) return { type: 'same' };

    tx.set(ref, next);
    return { type: 'changed', prev: Array.isArray(prev.options) ? prev.options : [] };
  });
}

const bundleCache = new Map(); // productId → fingerprint (para iwas-basa sa Firestore)

listen(
  'bundles',
  () => db.collection('prices'),
  async (change) => {
    const productId = change.doc.id;

    if (change.type === 'removed') {
      bundleCache.delete(productId);
      return;
    }

    const opts = normalizeBundles(change.doc.data());
    const fp = fingerprint(opts);

    if (bundleCache.get(productId) === fp) return; // walang nagbago sa bundles
    bundleCache.set(productId, fp);

    const result = await diffBundleState(productId, opts, fp);
    if (result.type !== 'changed') return;

    const prevById = new Map(result.prev.map((o) => [o.id, o]));
    const added = opts.filter((o) => !prevById.has(o.id));
    const repriced = opts.filter(
      (o) => prevById.has(o.id) && prevById.get(o.id).price !== o.price
    );

    if (added.length === 0 && repriced.length === 0) return; // may tinanggal lang

    const productName = await getProductName(productId);

    if (added.length > 0) {
      console.log(`Bagong bundle para sa: ${productName}`);
      await notifyStaff(
        'New Bundle Option Available!',
        `A new bundle option has been added for ${productName}: ${added
          .map(describeBundle)
          .join(', ')}. Check SariPrice for the available quantities and bundle prices.`,
        { type: NOTIF_TYPE.NEW_BUNDLE, productId }
      );
    } else {
      console.log(`Nagbago ang presyo ng bundle ng: ${productName}`);
      await notifyStaff(
        'Bundle Price Updated',
        `The bundle price for ${productName} has changed: ${repriced
          .map(describeBundle)
          .join(', ')}.`,
        { type: NOTIF_TYPE.BUNDLE_PRICE, productId }
      );
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// HTTP: HEALTH CHECK + KEEP-ALIVE
// ═══════════════════════════════════════════════════════════════
const app = express();

app.get('/', (req, res) => {
  res.status(200).send('SariPrice Push Server running!');
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    server: 'SariPrice Push Server',
    uptime_seconds: Math.round((Date.now() - STARTED_AT) / 1000),
    listeners: listenerStatus,
    last_notification_at: lastNotificationAt,
  });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server started on port ${PORT}`);
});

// Mag-ping sa sarili habang gising ang server para hindi ito ma-idle.
// (Hindi nito magigising ang server kapag tulog na — kailangan din ng external
//  pinger gaya ng UptimeRobot/cron-job.org, o paid instance.)
if (SELF_URL && typeof fetch === 'function') {
  const pingUrl = `${SELF_URL.replace(/\/+$/, '')}/health`;
  console.log(`Keep-alive: ping ${pingUrl} kada ${KEEP_ALIVE_MINUTES} minuto`);

  setInterval(async () => {
    try {
      await fetch(pingUrl);
    } catch (e) {
      console.log('[keep-alive] failed:', e.message);
    }
  }, KEEP_ALIVE_MINUTES * 60 * 1000);
} else {
  console.log('Keep-alive OFF (walang RENDER_EXTERNAL_URL/SELF_URL o walang global fetch)');
}

// Maayos na pag-shutdown kapag nag-deploy/nag-restart ang Render
function shutdown(signal) {
  console.log(`${signal} natanggap — nagsasara...`);
  for (const unsub of Object.values(unsubscribers)) {
    try { unsub(); } catch (_) { /* ignore */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));