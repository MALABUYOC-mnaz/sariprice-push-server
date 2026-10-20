const admin = require('firebase-admin');
const express = require('express');

// ✅ PRODUCTION (Render): load from env var
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// ✅ TESTING: load from file
// const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════
// ✅ PANGGAMOT SA FLOODING
// ═══════════════════════════════════════════════════════════════
const SERVER_START_TIME = Date.now();

// ═══════════════════════════════════════════════════════════════
// HELPER: Kunin lahat ng FCM tokens ng staff
// ═══════════════════════════════════════════════════════════════
async function getStaffTokens() {
  const usersSnap = await db.collection('users')
    .where('role', '==', 'Staff')
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

      // ✅ PAGGAMIT NG SERVER_START_TIME
      const isNewSinceStartup = createdAt.getTime() >= SERVER_START_TIME;
      const ageSeconds = (Date.now() - createdAt.getTime()) / 1000;

      if (!isNewSinceStartup || ageSeconds > 60) return;

      console.log(`New Product: ${productName}`);

      const tokens = await getStaffTokens();
      await sendToAll(
        tokens,
        'New Product Available!',
        `A new ${productName} has been added to the shelf. Check it in SariPrice now!`,
        { type: 'new_product', productId: change.doc.id }
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// LISTENER 2: Price Updates (May Increase/Decrease Alert)
// ═══════════════════════════════════════════════════════════════
console.log('Nakikinig sa price_history collection...');

db.collection('price_history').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'added') {
      const data = change.doc.data();
      const oldPrice = data.old_price || 0;
      const newPrice = data.new_price || 0;

      if (oldPrice === newPrice) return;

      // ✅ PAGGAMIT NG SERVER_START_TIME
      const changedAt = data.changed_at?.toDate?.() || new Date();
      const isNewSinceStartup = changedAt.getTime() >= SERVER_START_TIME;
      if (!isNewSinceStartup) return;

      const productId = data.product_id;
      const productDoc = await db.collection('products').doc(productId).get();
      const productName = productDoc.data()?.product_name || 'Produkto';

      const isIncrease = newPrice > oldPrice;
      const title = isIncrease ? 'Price Increase Alert' : 'Price Decrease Alert';
      
      console.log(`Price update: ${productName} ${isIncrease ? 'Increased' : 'Decreased'}`);

      const tokens = await getStaffTokens();
      await sendToAll(
        tokens,
        title,
        `${productName}: ₱${oldPrice} → ₱${newPrice}`, // ✅ Inayos ko yung text
        { type: 'price_update', productId: productId }
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// LISTENER 3: New Bundle Options (mula sa prices collection)
// ═══════════════════════════════════════════════════════════════
console.log('Nakikinig sa bundles sa prices collection...');

db.collection('prices').onSnapshot((snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    if (change.type === 'modified' || change.type === 'added') {
      const priceData = change.doc.data();
      const productId = change.doc.id; 
      
      const rawOpts = priceData['pricing_options'] || priceData['bundles'];
      
      if (rawOpts && Array.isArray(rawOpts) && rawOpts.length > 0) {
        
        // ✅ PAGGAMIT NG SERVER_START_TIME
        const updatedAt = priceData['updated_at']?.toDate?.() || new Date();
        const isNewSinceStartup = updatedAt.getTime() >= SERVER_START_TIME;
        
        if (!isNewSinceStartup) return;

        const productDoc = await db.collection('products').doc(productId).get();
        const productName = productDoc.data()?.product_name || 'Produkto';

        console.log(`Bagong bundle para sa: ${productName}`);

        const tokens = await getStaffTokens();
        await sendToAll(
          tokens,
          'New Bundle Option Available!',
          `A new bundle option has been added for ${productName}. Check SariPrice for the available quantities and bundle prices.`,
          { type: 'new_bundle', productId: productId }
        );
      }
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