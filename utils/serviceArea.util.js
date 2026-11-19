import { ServiceArea } from "../model/serviceArea.model.js";

// ── Postcode helpers ──────────────────────────────────────────────────
export const normalizePostcode = (raw) =>
  (raw ?? "").toString().toUpperCase().replace(/\s+/g, " ").trim();

export const compactPostcode = (raw) => normalizePostcode(raw).replace(/\s/g, "");

export const isFullPostcode = (raw) =>
  /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/.test(normalizePostcode(raw));

export const isDistrict = (raw) =>
  /^[A-Z]{1,2}\d[A-Z\d]?$/.test(compactPostcode(raw));

// "BR5 3DA" -> "BR5"; "BR5" -> "BR5"; anything else -> ""
export const districtOf = (raw) => {
  const c = compactPostcode(raw);
  const m = c.match(/^([A-Z]{1,2}\d[A-Z\d]?)\d[A-Z]{2}$/);
  if (m) return m[1];
  if (/^[A-Z]{1,2}\d[A-Z\d]?$/.test(c)) return c;
  return "";
};

export const extractPostcodeFromText = (text) => {
  const m = (text ?? "")
    .toString()
    .match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
  return m ? normalizePostcode(m[1]) : "";
};

// The provider's wash (service) address decides coverage; fall back to
// the home/provider address, then to a postcode written in the street
// line, so a formatting gap does not silently hide a provider.
export const providerPostcodeOf = (user) => {
  const direct =
    user?.serviceLocationAddress?.postcode || user?.providerAddress?.postcode || "";
  if (direct) return normalizePostcode(direct);
  return (
    extractPostcodeFromText(user?.serviceLocationAddress?.streetAddress || "") ||
    extractPostcodeFromText(user?.providerAddress?.streetAddress || "")
  );
};

// ── Coverage state ────────────────────────────────────────────────────
// restricted = at least one ServiceArea row exists. When nothing has
// been configured the whole feature is OFF and everything is covered.
export const getServiceAreaState = async () => {
  const total = await ServiceArea.countDocuments();
  if (!total) {
    return {
      restricted: false,
      activePostcodes: new Set(),
      activeDistricts: new Set(),
    };
  }
  const actives = await ServiceArea.find({ isActive: true })
    .select("postcode kind")
    .lean();
  const activePostcodes = new Set();
  const activeDistricts = new Set();
  for (const a of actives) {
    if (a.kind === "full") activePostcodes.add(compactPostcode(a.postcode));
    else if (a.kind === "district") activeDistricts.add(districtOf(a.postcode));
  }
  return { restricted: true, activePostcodes, activeDistricts };
};

export const coverageForPostcode = (state, rawPostcode) => {
  if (!state.restricted) return { restricted: false, covered: true };
  const pc = normalizePostcode(rawPostcode);
  if (!pc) return { restricted: true, covered: false };
  if (state.activePostcodes.has(compactPostcode(pc))) {
    return { restricted: true, covered: true };
  }
  const d = districtOf(pc);
  if (d && state.activeDistricts.has(d)) return { restricted: true, covered: true };
  return { restricted: true, covered: false };
};

export const isProviderCovered = async (userDoc) => {
  const state = await getServiceAreaState();
  if (!state.restricted) return true;
  return coverageForPostcode(state, providerPostcodeOf(userDoc)).covered;
};
