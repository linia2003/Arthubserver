const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;



app.use(cors({
  origin: "http://localhost:3000",
  credentials: true, // 
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const uri = process.env.MONGO_DB_URI;
if (!uri) {
  console.error(" ERROR: MONGO_DB_URI is undefined. Check your server .env file configuration.");
  process.exit(1);
}

const client = new MongoClient(uri);

async function runServer() {
  try {
    await client.connect();
    console.log(" Standalone Backend server successfully bound live connection tunnel to MongoDB cluster!");

    const db = client.db("arthub-db");
    const artworksCollection = db.collection("artworks");
    const transactionsCollection = db.collection("transactions");
    const usersCollection = db.collection("user");

 

    // get all artworks 
    app.get("/api/artworks", async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 100;
        let artworks;

              
        if (limit === 6) {
          artworks = await artworksCollection
            .aggregate([{ $sample: { size: 6 } }])
            .toArray();
        } else {
        
          artworks = await artworksCollection
            .find({})
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();
        }

        res.status(200).json({ success: true, artworks });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // fetch artwork by id
    app.get("/api/artworks/:id", async (req, res) => {
      try {
        const { id } = req.params;
        let query = {};
        
        if (ObjectId.isValid(id)) {
          query = { _id: new ObjectId(id) };
        } else {
          query = { _id: id };
        }

        const artwork = await artworksCollection.findOne(query);
        if (!artwork) {
          return res.status(404).json({ success: false, message: "Specified item record missing from cloud cluster." });
        }
        res.status(200).json({ success: true, artwork });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });


    //  User/buyer part
  

    // user transaction
    app.get("/api/user/purchases", async (req, res) => {
      try {
        const { email } = req.query;
        const history = await transactionsCollection.find({ userEmail: email, type: "purchase" }).toArray();
        res.status(200).json({ success: true, history });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

   
    // Artist part
  

    // artist mangement list
    app.get("/api/artist/artworks", async (req, res) => {
      try {
        const { email } = req.query;
        const artworks = await artworksCollection.find({ artistEmail: email }).toArray();
        res.status(200).json({ success: true, artworks });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // new art add
    app.post("/api/artworks", async (req, res) => {
      try {
        const newArtwork = {
          ...req.body,
          price: parseFloat(req.body.price),
          createdAt: new Date()
        };
        const result = await artworksCollection.insertOne(newArtwork);
        res.status(201).json({ success: true, insertedId: result.insertedId });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // edit art
    app.put("/api/artworks/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const updateData = { ...req.body, price: parseFloat(req.body.price) };
        delete updateData._id;

        const result = await artworksCollection.updateOne(
          { _id: ObjectId.isValid(id) ? new ObjectId(id) : id },
          { $set: updateData }
        );
        res.status(200).json({ success: true, modifiedCount: result.modifiedCount });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // Delete artwork
    app.delete("/api/artworks/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const result = await artworksCollection.deleteOne({
          _id: ObjectId.isValid(id) ? new ObjectId(id) : id
        });
        res.status(200).json({ success: true, deletedCount: result.deletedCount });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

   
    //  Admin
    

    // Admin analytics part ta
    app.get("/api/admin/analytics", async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments({ role: "user" });
        const totalArtists = await usersCollection.countDocuments({ role: "artist" });
        
        const salesData = await transactionsCollection.find({ type: "purchase" }).toArray();
        const totalArtworksSold = salesData.length;
        
        const totalRevenue = salesData.reduce((sum, tx) => sum + (tx.amount || 0), 0);

        // Grouping artworks by category for frontend charts
        const categoryAggregation = await artworksCollection.aggregate([
          { $group: { _id: "$category", count: { $sum: 1 } } }
        ]).toArray();

        res.status(200).json({
          success: true,
          analytics: { totalUsers, totalArtists, totalArtworksSold, totalRevenue },
          categoriesChart: categoryAggregation
        });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // Admin user manage part
    app.get("/api/admin/users", async (req, res) => {
      try {
        const users = await usersCollection.find({}).toArray();
        res.status(200).json({ success: true, users });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // Admin user update part
    app.patch("/api/admin/users/:id/role", async (req, res) => {
      try {
        const { id } = req.params;
        const { role } = req.body;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role: role } }
        );
        res.status(200).json({ success: true, updated: result.modifiedCount });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

    // purchase & Subscriptions Ledger
    app.get("/api/admin/transactions", async (req, res) => {
      try {
        const transactions = await transactionsCollection.find({}).sort({ date: -1 }).toArray();
        res.status(200).json({ success: true, transactions });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

  } catch (error) {
    console.error("Critical database server handshake failure:", error);
  }
}
app.get("/api/dev/force-admin", async (req, res) => {
      try {
        const adminUser = await usersCollection.findOne({ email: "arthub@gmail.com" });
        res.status(200).json({ success: true, user: adminUser });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    });

runServer();

app.get("/", (req, res) => {
  res.send("ArtHub Express Backend Gateway is Operational.");
});

app.listen(port, () => {
  console.log(` Independent API node broadcasting dynamically on port ${port}`);
});