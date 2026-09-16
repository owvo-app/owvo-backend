import jwt from 'jsonwebtoken';

const DEFAULT_ACCESS_TOKEN_EXPIRES_IN = "1h";
const DEFAULT_REFRESH_TOKEN_EXPIRES_IN = "30d";

const getConfiguredValue = (name) => process.env[name]?.trim();

const getRequiredSecret = (name) => {
  const secret = getConfiguredValue(name);
  if (!secret) {
    throw new Error(`${name} must be configured before the server can start.`);
  }
  return secret;
};

const getExpiresIn = (name, fallback) => getConfiguredValue(name) || fallback;

export const getAccessTokenExpiresIn = () =>
  getExpiresIn("JWT_ACCESS_EXPIRES_IN", DEFAULT_ACCESS_TOKEN_EXPIRES_IN);

export const getRefreshTokenExpiresIn = () =>
  getExpiresIn("JWT_REFRESH_EXPIRES_IN", DEFAULT_REFRESH_TOKEN_EXPIRES_IN);

const validateTokenSettings = (secret, expiresIn, expiresInName) => {
  try {
    jwt.sign({ configValidation: true }, secret, { expiresIn });
  } catch (error) {
    throw new Error(
      `${expiresInName} is invalid. Use seconds (for example 3600) or a timespan such as 1h, 7d, or 30d. ${error.message}`
    );
  }
};

export const validateAuthConfiguration = () => {
  const accessSecret = getRequiredSecret("JWT_ACCESS_SECRET");
  const refreshSecret = getRequiredSecret("JWT_REFRESH_SECRET");
  const accessExpiresIn = getAccessTokenExpiresIn();
  const refreshExpiresIn = getRefreshTokenExpiresIn();

  validateTokenSettings(accessSecret, accessExpiresIn, "JWT_ACCESS_EXPIRES_IN");
  validateTokenSettings(refreshSecret, refreshExpiresIn, "JWT_REFRESH_EXPIRES_IN");

  if (!getConfiguredValue("JWT_ACCESS_EXPIRES_IN")) {
    console.warn(
      `JWT_ACCESS_EXPIRES_IN is not set; using the safe default of ${DEFAULT_ACCESS_TOKEN_EXPIRES_IN}.`
    );
  }
  if (!getConfiguredValue("JWT_REFRESH_EXPIRES_IN")) {
    console.warn(
      `JWT_REFRESH_EXPIRES_IN is not set; using the safe default of ${DEFAULT_REFRESH_TOKEN_EXPIRES_IN}.`
    );
  }
};

export const createToken = (
  jwtPayload,
  secret,
  expiresIn,
) => {
  if (!secret?.toString().trim()) {
    throw new Error("JWT secret is not configured.");
  }
  if (typeof expiresIn !== "string" && typeof expiresIn !== "number") {
    throw new Error("JWT expiry must be a number of seconds or a timespan string.");
  }
  return jwt.sign(jwtPayload, secret, { expiresIn });
};

export const verifyToken = (
  token,
  secret
)=> {
  return jwt.verify(token, secret) ;
};