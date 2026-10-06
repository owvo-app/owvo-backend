import admin from "firebase-admin";
import { User } from "../model/user.model.js";

/**
 * Firebase Cloud Messaging (push notifications).
 *
 * Setup: set these env vars from the Firebase console
 * (Project Settings → Service Accounts → Generate new private key):
 *   FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY
 * (private key keeps its \n escapes — they are converted below)
 *
 * If the vars are missing, push is silently disabled and every
 * send helper resolves with { sent: 0, skipped: true }.
 */

let initialized = false;

export const initFcm = () => {
  if (initialized) return true;

  const projectId = process.env.FCM_PROJECT_ID;
  const clientEmail = process.env.FCM_CLIENT_EMAIL;
  let privateKey = process.env.FCM_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.warn("[FCM] FCM_* env vars missing — push notifications disabled.");
    return false;
  }

  privateKey = privateKey.replace(/\\n/g, "\n");

  try {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    });
  } catch (e) {
    console.warn(
      "[FCM] init failed — push disabled. Check FCM_* env vars:",
      e?.message || e
    );
    return false;
  }

  initialized = true;
  console.log("[FCM] firebase-admin initialised.");
  return true;
};

export const isFcmReady = () => initialized;

const getUserTokens = async (userId) => {
  if (!userId) return [];
  const user = await User.findById(userId).select("fcmTokens").lean();
  const tokens = user?.fcmTokens || [];
  return [...new Set(tokens.map((t) => t?.token).filter(Boolean))];
};

/** Remove dead tokens so we don't keep retrying them. */
const pruneInvalidTokens = async (userId, badTokens) => {
  if (!userId || !badTokens.length) return;
  try {
    await User.updateOne(
      { _id: userId },
      { $pull: { fcmTokens: { token: { $in: badTokens } } } }
    );
  } catch (e) {
    console.warn("[FCM] token prune failed:", e?.message || e);
  }
};

const INVALID_TOKEN_CODES = new Set([
  "messaging/invalid-registration-token",
  "messaging/registration-token-not-registered",
]);

/**
 * Send a push notification to every device registered for a user.
 * Never throws — failures are logged and counted.
 */
export const sendPushToUser = async (
  userId,
  { title, body, data = {} } = {}
) => {
  if (!initialized) return { sent: 0, failed: 0, skipped: true };
  if (!userId || !title) return { sent: 0, failed: 0, skipped: true };

  const tokens = await getUserTokens(userId);
  if (!tokens.length) return { sent: 0, failed: 0, skipped: true };

  const stringData = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v !== undefined && v !== null) stringData[k] = String(v);
  }

  try {
    const res = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body: body || "" },
      data: stringData,
      android: {
        priority: "high",
        notification: { channelId: "owvo_bookings", sound: "default" },
      },
      apns: { payload: { aps: { sound: "default", badge: 1 } } },
    });

    const badTokens = [];
    res.responses.forEach((r, i) => {
      if (!r.success && INVALID_TOKEN_CODES.has(r.error?.code)) {
        badTokens.push(tokens[i]);
      }
    });
    if (badTokens.length) await pruneInvalidTokens(userId, badTokens);

    return { sent: res.successCount, failed: res.failureCount };
  } catch (e) {
    console.warn("[FCM] send failed:", e?.message || e);
    return { sent: 0, failed: tokens.length };
  }
};

/** Fire-and-forget wrapper for use inside request handlers. */
export const notifyUser = (userId, payload) => {
  sendPushToUser(userId, payload).catch((e) =>
    console.warn("[FCM] notify failed:", e?.message || e)
  );
};
