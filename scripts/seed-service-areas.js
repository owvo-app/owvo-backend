// Seed the first Service Areas (idempotent):
//  - London / South East London — placeholder row (no postcode yet); the
//    client adds the exact postcodes from the dashboard and activates.
//  - Isle of Wight / Newport / PO30 — ACTIVE, so the existing test
//    providers keep working once areas exist.
// Run:  node scripts/seed-service-areas.js --dry   (plan only)
//       node scripts/seed-service-areas.js         (write)
import mongoose from "mongoose";
import { ServiceArea } from "../model/serviceArea.model.js";

const dry = process.argv.includes("--dry");
const uri = process.env.MONGO_DB_URL;
if (!uri) {
  console.error("MONGO_DB_URL is not set.");
  process.exit(1);
}
await mongoose.connect(uri);

const wanted = [
  { city: "London", areaName: "South East London", postcode: "", postcodeDistrict: "", kind: "placeholder", isActive: false },
  { city: "Isle of Wight", areaName: "Newport", postcode: "PO30", postcodeDistrict: "PO30", kind: "district", isActive: true },
];

for (const w of wanted) {
  const existing = await ServiceArea.findOne({
    areaName: w.areaName,
    postcode: w.postcode,
  }).lean();
  if (existing) {
    console.log(`SKIP (exists): ${w.areaName} / ${w.postcode || "—"}`);
    continue;
  }
  console.log(`${dry ? "WOULD CREATE" : "CREATE"}: ${w.city} / ${w.areaName} / ${w.postcode || "—"} active=${w.isActive}`);
  if (!dry) await ServiceArea.create(w);
}
await mongoose.disconnect();
console.log("Done.");
