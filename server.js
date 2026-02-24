import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import session from 'express-session';
import dotenv from 'dotenv';
import { PRODUCTS } from './products.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_secret_change_me';

// --- Middleware ---
app.use(helmet());
app.use(express.json());
app.use(morgan('dev'));

// Enable cookies for session when calling from your front-end.
// If you deploy frontend on same origin as API, you can tighten this later.
app.use(cors({
  origin: true,            // reflect the origin
  credentials: true        // allow cookies
}));

// Session (MemoryStore: fine for demos, not for production)
app.use(session({
  name: 'shoplite.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,   // set true when serving over HTTPS
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  }
}));

// --- Helpers ---
function normalizeSession(req) {
  if (!req.session.cart) req.session.cart = {};       // { [productId]: { qty } }
  if (!req.session.wishlist) req.session.wishlist = {}; // { [productId]: true }
}

function toNumber(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function filterSortProducts({ query, category, maxPrice, sort }) {
  const q = (query || '').trim().toLowerCase();
  const cat = category || '';
  const max = maxPrice ? Number(maxPrice) : Number.POSITIVE_INFINITY;

  let out = PRODUCTS.filter(p => {
    const matchQ = !q || p.name.toLowerCase().includes(q) || p.tags.some(t => t.toLowerCase().includes(q));
    const matchC = !cat || p.category === cat;
    const matchP = p.price <= max;
    return matchQ && matchC && matchP;
  });

  switch (sort) {
    case 'price-asc': out.sort((a,b)=>a.price-b.price); break;
    case 'price-desc': out.sort((a,b)=>b.price-a.price); break;
    case 'rating-desc': out.sort((a,b)=>b.rating-a.rating); break;
    case 'newest': out.sort((a,b)=> new Date(b.created) - new Date(a.created)); break;
    default:
      out.sort((a,b)=> (b.rating*10 + (b.compareAt?1:0)) - (a.rating*10 + (a.compareAt?1:0)));
  }
  return out;
}

function calcSummary(cart) {
  let subtotal = 0;
  const items = Object.entries(cart).map(([id, { qty }]) => {
    const p = PRODUCTS.find(x => x.id === id);
    if (!p) return null;
    const lineTotal = p.price * qty;
    subtotal += lineTotal;
    return {
      id: p.id,
      name: p.name,
      price: p.price,
      img: p.img,
      qty,
      lineTotal
    };
  }).filter(Boolean);

  const shipping = subtotal > 200 ? 0 : (subtotal === 0 ? 0 : 9.99);
  const tax = subtotal * 0.08;
  const total = subtotal + shipping + tax;

  return { items, subtotal, shipping, tax, total };
}

// --- API Routes ---
// Health
app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Products
app.get('/api/products', (req, res) => {
  const { search, category, maxPrice, sort } = req.query;
  const list = filterSortProducts({
    query: search,
    category,
    maxPrice,
    sort
  });
  res.json({ products: list });
});

app.get('/api/products/:id', (req, res) => {
  const p = PRODUCTS.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

// Cart
app.get('/api/cart', (req, res) => {
  normalizeSession(req);
  const summary = calcSummary(req.session.cart);
  res.json({
    cart: req.session.cart,
    ...summary
  });
});

// Add or increment
app.post('/api/cart', (req, res) => {
  normalizeSession(req);
  const { id, qty } = req.body || {};
  const product = PRODUCTS.find(p => p.id === id);
  const q = toNumber(qty, 1);
  if (!product) return res.status(400).json({ error: 'Invalid product id' });
  if (q <= 0) return res.status(400).json({ error: 'Quantity must be > 0' });

  const item = req.session.cart[id] || { qty: 0 };
  item.qty += q;
  req.session.cart[id] = item;

  const summary = calcSummary(req.session.cart);
  res.json({ ok: true, cart: req.session.cart, ...summary });
});

// Update quantity
app.patch('/api/cart/:id', (req, res) => {
  normalizeSession(req);
  const id = req.params.id;
  const q = toNumber(req.body?.qty, NaN);
  if (!Number.isFinite(q)) return res.status(400).json({ error: 'qty required' });

  if (q <= 0) {
    delete req.session.cart[id];
  } else {
    if (!PRODUCTS.some(p => p.id === id)) return res.status(400).json({ error: 'Invalid product id' });
    req.session.cart[id] = { qty: q };
  }
  const summary = calcSummary(req.session.cart);
  res.json({ ok: true, cart: req.session.cart, ...summary });
});

// Remove line
app.delete('/api/cart/:id', (req, res) => {
  normalizeSession(req);
  delete req.session.cart[req.params.id];
  const summary = calcSummary(req.session.cart);
  res.json({ ok: true, cart: req.session.cart, ...summary });
});

// Wishlist
app.get('/api/wishlist', (req, res) => {
  normalizeSession(req);
  const ids = Object.keys(req.session.wishlist);
  const items = PRODUCTS.filter(p => ids.includes(p.id));
  res.json({ ids, items });
});

// Set wish (true/false) or toggle if not provided
app.put('/api/wishlist/:id', (req, res) => {
  normalizeSession(req);
  const id = req.params.id;
  const exists = PRODUCTS.some(p => p.id === id);
  if (!exists) return res.status(400).json({ error: 'Invalid product id' });

  const want = req.body?.wish;
  if (typeof want === 'boolean') {
    if (want) req.session.wishlist[id] = true; else delete req.session.wishlist[id];
  } else {
    if (req.session.wishlist[id]) delete req.session.wishlist[id]; else req.session.wishlist[id] = true;
  }
  res.json({ ok: true, ids: Object.keys(req.session.wishlist) });
});

app.delete('/api/wishlist/:id', (req, res) => {
  normalizeSession(req);
  delete req.session.wishlist[req.params.id];
  res.json({ ok: true, ids: Object.keys(req.session.wishlist) });
});

// Checkout (mock)
// Accepts either:
//  A) Use-session-cart: { name, email }
//  B) Client-provided items: { name, email, items: [{ id, qty }, ...] }
app.post('/api/checkout', (req, res) => {
  normalizeSession(req);
  const { name, email, items } = req.body || {};

  if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

  // If items provided, temporarily compute with those (does not mutate session)
  let cartForCalc = req.session.cart;
  if (Array.isArray(items)) {
    const tempCart = {};
    for (const row of items) {
      const id = row?.id;
      const qty = toNumber(row?.qty, 0);
      if (!id || qty <= 0) continue;
      if (!PRODUCTS.some(p => p.id === id)) continue;
      tempCart[id] = { qty: (tempCart[id]?.qty || 0) + qty };
    }
    cartForCalc = tempCart;
  }

  const summary = calcSummary(cartForCalc);
  if (summary.items.length === 0) {
    return res.status(400).json({ error: 'Cart is empty' });
  }

  const orderId = 'ord_' + Math.random().toString(36).slice(2, 10);
  const order = {
    id: orderId,
    name,
    email,
    ...summary,
    createdAt: new Date().toISOString(),
    note: 'Mock checkout — no payment processed'
  };

  // For demo we don’t persist orders. You could push into an in-memory array or DB here.
  // Clear session cart on success if the session cart was used
  if (!Array.isArray(items)) {
    req.session.cart = {};
  }

  res.json(order);
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`ShopLite API running on http://localhost:${PORT}`);
});
