import { Counter } from "../model/counter.model.js";

// Agla sequential number atomic tareeqe se (findOneAndUpdate + $inc).
// Istemal: transactions ke TXN numbers, refund numbers waghera.
export const getNextSequence = async (key) => {
  const doc = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
};

// "TXN001258" wala style — unified transactions ledger ke liye.
export const formatTxnNumber = (seq) => `TXN${String(seq).padStart(6, "0")}`;

export const getNextTxnNumber = async () => {
  const seq = await getNextSequence("txn");
  return formatTxnNumber(seq);
};
