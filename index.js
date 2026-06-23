const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const cors = require("cors");
require("dotenv").config();

const app = express();
const port = process.env.PORT || 5000;


app.use(cors({
  origin: ["http://localhost:3000"],
  credentials: true
}));
app.use(express.json());

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

  } catch (error) {
    console.error("Critical database server handshake failure:", error);
  }
}

runServer();

app.get("/", (req, res) => {
  res.send("ArtHub Express Backend Gateway is Operational.");
});

app.listen(port, () => {
  console.log(` Independent API node broadcasting dynamically on port ${port}`);
});