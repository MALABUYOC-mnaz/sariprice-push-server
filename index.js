const admin = require('firebase-admin');
const express = require('express');

// ✅ Load service account mula sa environment variable
// (para hindi mai-commit sa GitHub)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════
// HELPER: Kunin lahat ng FCM tokens ng staff
// ═══════════════════════════════════════════════════════════════
async function getStaffTokens() {
  const usersSnap = await db.collection('users')
    .where('role', '==', 'staff')
    .get();

  const tokens = [];
  usersSnap.forEach((doc) => {
    const token = doc.data().fcm_token;
    if (token) tokens.push(token);
  });
  return tokens;
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Magpadala ng notification sa lahat ng tokens
// ═══════════════════════════════════════════════════════════════
async function sendToAll(tokens, title, body, data = {}) {
  if (tokens.length === 0) {
    console.log('Walang tokens — skip');
    return;
  }

  const message = {
    notification: { title, body },
    data: data,
    tokens: tokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`${response.successCount} sent, ${response.failureCount} failed`);

    // Cleanup invalid tokens
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        console.log(`Token ${idx} failed: ${resp.error?.code}`);
      }
    });
  } catch (error) {
    console.error('Error sending:', error);
  }
}

// ═══════════════════════════════════════════════════════════════
// LISTENER 1: Bagong product
// ═══════════════════════════════════════════════════════════════
console.log('Nakikinig sa products collection...');

db.collection('products').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const product = change.doc.data();
      const productName = product.product_name || 'Bagong produkto';
      const createdAt = product.created_at?.toDate?.() || new Date();

      // Skip kung masyadong luma (>1 minuto) — para hindi mag-notify sa startup
      const ageSeconds = (Date.now() - createdAt.getTime()) / 1000;
      if (ageSeconds > 60) return;

      console.log(`Bagong product: ${productName}`);

      const tokens = await getStaffTokens();
      await sendToAll(
        tokens,
        'Bagong Produkto',
        `${productName} ay naidagdag na sa tindahan`,
        { type: 'new_product', productId: change.doc.id }
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// LISTENER 2: Price updates
// ═══════════════════════════════════════════════════════════════
console.log('Nakikinig sa price_history collection...');

db.collection('price_history').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const oldPrice = data.old_price || 0;
      const newPrice = data.new_price || 0;

      if (oldPrice === newPrice) return;

      const productId = data.product_id;
      const productDoc = await db.collection('products').doc(productId).get();
      const productName = productDoc.data()?.product_name || 'Produkto';

      const direction = newPrice > oldPrice ? 'tumaas' : 'bumaba';
      console.log(`Price update: ${productName} ${direction}`);

      const tokens = await getStaffTokens();
      await sendToAll(
        tokens,
        'Price Update',
        `${productName}: ₱${oldPrice} → ₱${newPrice} (${direction})`,
        { type: 'price_update', productId: productId }
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// HEALTH CHECK ENDPOINT (para sa Render)
// ═══════════════════════════════════════════════════════════════
const app = express();
app.get('/', (req, res) => res.send('SariPrice Push Server running!'));
app.listen(process.env.PORT || 3000, () => {
  console.log('Server started');
});