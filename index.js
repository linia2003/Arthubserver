require("dotenv").config(); // 🌟 MUST BE FIRST LINE to map environment variables safely
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const { betterAuth } = require("better-auth");
const { mongodbAdapter } = require("better-auth/adapters/mongodb");

const app = express();
const port = process.env.PORT || 5000;

// 1. ALLOW CORS FOR FRONTEND DOMAINS
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://arthub-mauve.vercel.app" 
  ],
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Global variables for lazy initialization across Serverless environments
let client;
let db;
let auth;

const uri = process.env.MONGO_DB_URI;
if (!uri) {
  console.error("❌ ERROR: MONGO_DB_URI is undefined.");
  process.exit(1);
}

// =========================================================================
// 2. 💳 STRIPE WEBHOOK ENDPOINT (MUST BE RAW BINARY PARSING, BEFORE express.json())
// =========================================================================
app.post("/api/payment/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`❌ Webhook Signature Verification Failed:`, err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    try {
      // Warm up backup connections if webhook hits before a standard application pipeline requests it
      if (!client) client = new MongoClient(uri);
      if (!db) {
        await client.connect();
        db = client.db("arthub-db");
      }

      // CASE A: User Subscription Handling
      if (session.metadata.tier) {
        const userEmail = session.metadata.userEmail;
        const targetTier = session.metadata.tier;

        await db.collection("user").updateOne(
          { email: userEmail },
          { $set: { subscriptionTier: targetTier, updatedAt: new Date() } }
        );
        console.log(`✨ Successfully upgraded ${userEmail} to tier: ${targetTier}`);
      }

      // CASE B: 🎨 Artwork Purchase Multi-Role Ledger Generation
      if (session.metadata.type === "artwork_purchase") {
        const meta = session.metadata;

        const purchaseRecord = {
          artworkId: meta.artworkId,
          artworkTitle: meta.artworkTitle,
          amount: parseFloat(meta.amount),
          userEmail: meta.buyerEmail,    // Triggers user logs fetch
          buyerName: meta.buyerName,      // Feeds name into artist loops
          artistEmail: meta.artistEmail,  // Triggers artist sale records
          artistName: meta.artistName,
          type: "purchase",               // Category identifier for general tracking
          date: new Date()
        };

        await db.collection("transactions").insertOne(purchaseRecord);
        console.log(`🎨 Ledger entry populated! ${meta.buyerName} purchased "${meta.artworkTitle}"`);
      }

    } catch (dbErr) {
      console.error("❌ Failed to parse transaction event details inside webhook:", dbErr);
      return res.status(500).send("Internal DB adjustment failure");
    }
  }

  res.json({ received: true });
});

// 3. NOW ACTIVATE JSON BODY PARSING FOR REMAINING ENDPOINTS
app.use(express.json());

// 4. DATABASE & AUTH ENGINE POOL INITIALIZATION MIDDLEWARE
app.use(async (req, res, next) => {
  try {
    if (!client) {
      client = new MongoClient(uri);
    }
    if (!db) {
      await client.connect();
      db = client.db("arthub-db");
    }
    if (!auth) {
      auth = betterAuth({
        database: mongodbAdapter(db, {
          client,
          collections: { user: "user" }
        }),
        advanced: {
          crossSubdomainCookie: true 
        },
        trustedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000", "https://arthub-mauve.vercel.app"],
        user: {
          additionalFields: {
            role: { type: "string", defaultValue: "user", input: false },
          },
        },
        emailAndPassword: { 
          enabled: true,
          autoLinkToProvider: ["google"] 
        },
        socialProviders: {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        },
      });
    }

    req.db = db;
    req.artworksCollection = db.collection("artworks");
    req.transactionsCollection = db.collection("transactions");
    req.usersCollection = db.collection("user");
    req.authInstance = auth;

    next();
  } catch (error) {
    console.error("Serverless Database handshake exception:", error);
    res.status(500).json({ success: false, message: "Database connection failed." });
  }
});

// =========================================================================
// 5. 💳 STRIPE CHECKOUT SESSION ROUTE MAPPINGS
// =========================================================================

// Endpoint A: Subscription Tier Plan Payments
app.post("/api/payment/create-checkout", async (req, res) => {
  try {
    const { email, tier, priceAmount } = req.body;
    if (!email || !tier) {
      return res.status(400).json({ success: false, message: "Missing tracking account validation attributes." });
    }

    const frontendUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `ArtHub ${tier.toUpperCase()} Tier Membership Upgrade`,
              description: `Unlocks complete upload capacity limits tailored to your specific account needs.`,
            },
            unit_amount: Math.round(priceAmount * 100),
          },
          quantity: 1,
        },
      ],
      metadata: { userEmail: email, tier: tier },
      success_url: `${frontendUrl}/dashboard/user?payment_success=true`,
      cancel_url: `${frontendUrl}/dashboard/user?payment_cancelled=true`,
    });

    res.status(200).json({ success: true, url: session.url });
  } catch (err) {
    console.error("Stripe Checkout Crash:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Endpoint B: 🎨 Artwork Purchase Flow with Tier Checking Limits Guard
app.post("/api/payment/create-artwork-checkout", async (req, res) => {
  try {
    const { buyerEmail, buyerName, artworkId } = req.body;

    if (!buyerEmail || !artworkId) {
      return res.status(400).json({ success: false, message: "Missing tracking identification parameters." });
    }

    const artwork = await req.artworksCollection.findOne({ 
      _id: ObjectId.isValid(artworkId) ? new ObjectId(artworkId) : artworkId 
    });
    if (!artwork) {
      return res.status(404).json({ success: false, message: "Artwork missing from marketplace portfolio." });
    }

    const userProfile = await req.usersCollection.findOne({ email: buyerEmail });
    const tier = userProfile?.subscriptionTier || "free";

    // Enforce limits for non-unlimited tiers
    if (tier === "free" || tier === "pro") {
      const currentPurchasesCount = await req.transactionsCollection.countDocuments({ 
        userEmail: buyerEmail, 
        type: "purchase" 
      });

      const maxLimit = tier === "free" ? 3 : 9;
      if (currentPurchasesCount >= maxLimit) {
        return res.status(403).json({ 
          success: false, 
          message: `Acquisition cap reached! Your current ${tier} plan limits you to ${maxLimit} artworks. Please upgrade.` 
        });
      }
    }

    const frontendUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: artwork.title,
              description: `Original masterwork compiled by artist ${artwork.artistName || "Exhibited Creator"}.`,
              images: artwork.image ? [artwork.image] : [],
            },
            unit_amount: Math.round(artwork.price * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: "artwork_purchase",
        artworkId: artworkId.toString(),
        artworkTitle: artwork.title,
        amount: artwork.price.toString(),
        buyerEmail: buyerEmail,
        buyerName: buyerName || "Anonymous Collector",
        artistEmail: artwork.artistEmail,
        artistName: artwork.artistName || "Exhibited Creator"
      },
      success_url: `${frontendUrl}/dashboard/user?purchase_success=true`,
      cancel_url: `${frontendUrl}/browse?purchase_cancelled=true`,
    });

    res.status(200).json({ success: true, url: session.url });
  } catch (err) {
    console.error("Artwork checkout creation fail:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// =========================================================================
// 🌟 ALL OTHER APPLICATION AND BETTER-AUTH ROUTE HANDLING
// =========================================================================
app.post("/api/auth/register-direct", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    const existingUser = await req.usersCollection.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "Email is already registered." });
    }

    const { randomBytes, scrypt } = require("crypto");
    const salt = randomBytes(16).toString("hex");
    const key = await new Promise((resolve, reject) => {
      scrypt(password.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }, (err, k) => err ? reject(err) : resolve(k));
    });
    const hashedPassword = `${salt}:${key.toString("hex")}`;

    const userId = new ObjectId();
    await req.usersCollection.insertOne({
      _id: userId,
      name,
      email,
      emailVerified: false,
      role: role || "user",
      subscriptionTier: "free", 
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const accountCollection = req.db.collection("account");
    await accountCollection.insertOne({
      _id: new ObjectId(),
      userId: userId,
      accountId: email,
      providerId: "credential",
      password: hashedPassword,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return res.status(201).json({ success: true, message: "Registered successfully!" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.all(/^\/api\/auth(?:\/(.*))?$/, async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    const webRequest = new Request(fullUrl, {
      method: req.method,
      headers: new Headers(req.headers),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body)
    });

    const webResponse = await req.authInstance.handler(webRequest); 
    webResponse.headers.forEach((value, key) => res.setHeader(key, value));
    res.status(webResponse.status);
    return res.send(await webResponse.text());
  } catch (err) {
    return res.status(500).json({ success: false, message: "Internal auth engine failure" });
  }
});

// get all artworks
app.get("/api/artworks", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    let artworks = (limit === 6)
      ? await req.artworksCollection.aggregate([{ $sample: { size: 6 } }]).toArray()
      : await req.artworksCollection.find({}).sort({ createdAt: -1 }).limit(limit).toArray();
    res.status(200).json({ success: true, artworks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// fetch artwork by id
app.get("/api/artworks/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id };
    const artwork = await req.artworksCollection.findOne(query);
    if (!artwork) return res.status(404).json({ success: false, message: "Record missing from cluster." });
    res.status(200).json({ success: true, artwork });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// user transactions history log
app.get("/api/user/purchases", async (req, res) => {
  try {
    const { email } = req.query;
    const history = await req.transactionsCollection.find({ userEmail: email, type: "purchase" }).toArray();
    res.status(200).json({ success: true, history });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// artist management list
app.get("/api/artist/artworks", async (req, res) => {
  try {
    const { email } = req.query;
    const artworks = await req.artworksCollection.find({ artistEmail: email }).toArray();
    res.status(200).json({ success: true, artworks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// add new artwork
app.post("/api/artworks", async (req, res) => {
  try {
    const newArtwork = { ...req.body, price: parseFloat(req.body.price), createdAt: new Date() };
    const result = await req.artworksCollection.insertOne(newArtwork);
    res.status(201).json({ success: true, insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// edit artwork
app.put("/api/artworks/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body, price: parseFloat(req.body.price) };
    delete updateData._id;
    const result = await req.artworksCollection.updateOne(
      { _id: ObjectId.isValid(id) ? new ObjectId(id) : id },
      { $set: updateData }
    );
    res.status(200).json({ success: true, updated: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// delete artwork
app.delete("/api/artworks/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await req.artworksCollection.deleteOne({ _id: ObjectId.isValid(id) ? new ObjectId(id) : id });
    res.status(200).json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Admin metrics endpoints
app.get("/api/admin/analytics", async (req, res) => {
  try {
    const totalUsers = await req.usersCollection.countDocuments({ role: "user" });
    const totalArtists = await req.usersCollection.countDocuments({ role: "artist" });
    const salesData = await req.transactionsCollection.find({ type: "purchase" }).toArray();
    const totalArtworksSold = salesData.length;
    const totalRevenue = salesData.reduce((sum, tx) => sum + (tx.amount || 0), 0);
    const categoryAggregation = await req.artworksCollection.aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }]).toArray();

    res.status(200).json({
      success: true,
      analytics: { totalUsers, totalArtists, totalArtworksSold, totalRevenue },
      categoriesChart: categoryAggregation
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/admin/users", async (req, res) => {
  try {
    const users = await req.usersCollection.find({}).toArray();
    res.status(200).json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch("/api/admin/users/:id/role", async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    const result = await req.usersCollection.updateOne({ _id: new ObjectId(id) }, { $set: { role: role } });
    res.status(200).json({ success: true, updated: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/admin/transactions", async (req, res) => {
  try {
    const transactions = await req.transactionsCollection.find({}).sort({ date: -1 }).toArray();
    res.status(200).json({ success: true, transactions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/", (req, res) => {
  res.send("ArtHub Express Backend Gateway is Operational.");
});

app.listen(port, () => {
  console.log(` Independent API node broadcasting dynamically on port ${port}`);
});

module.exports = app;