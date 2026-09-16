const defaultDevelopmentOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5006",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:5006",
];

const defaultProductionOrigins = [
  "https://owvo-backend-new.onrender.com",
  "https://owvo-dashboard.onrender.com",
  "https://owvo-admin-dashboard.netlify.app",
  "https://owvo-dashboard.netlify.app",
];

export const getAllowedOrigins = () => {
  const configured = process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGINS || "";
  const parsed = configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const defaults = process.env.NODE_ENV === "production" || process.env.RENDER
    ? defaultProductionOrigins
    : [...defaultDevelopmentOrigins, ...defaultProductionOrigins];

  return [...new Set([...defaults, ...parsed])];
};

export const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  return getAllowedOrigins().includes(origin);
};

export const corsOriginDelegate = (origin, callback) => {
  if (isAllowedOrigin(origin)) {
    callback(null, true);
    return;
  }

  callback(new Error("Origin is not allowed by OWVO CORS policy"));
};

