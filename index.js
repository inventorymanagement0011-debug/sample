// Kurly Katch - Shopify Order to WhatsApp Notifier
// Receives a Shopify "order creation" webhook and sends WhatsApp messages
// to the manager and the customer using Twilio's WhatsApp API.

const express = require("express");
const crypto = require("crypto");
const twilio = require("twilio");

const app = express();

// IMPORTANT: Shopify webhook verification needs the RAW request body,
// so we capture it before any JSON parsing happens.
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---------- CONFIG (set these as environment variables, never hard-code) ----------
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // from Shopify webhook setup
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM; // e.g. "whatsapp:+14155238886"
const MANAGER_WHATSAPP_NUMBER = process.env.MANAGER_WHATSAPP_NUMBER; // e.g. "whatsapp:+923314440625"
const ORDER_CONFIRMATION_TEMPLATE_SID = process.env.ORDER_CONFIRMATION_TEMPLATE_SID; // e.g. "HX1234567890abcdef..."

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- Verify the request actually came from Shopify ----------
function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// ---------- Build human-readable message text from order JSON ----------
function buildManagerMessage(order) {
  const items = order.line_items
    .map((item) => `• ${item.quantity}x ${item.title} - Rs.${item.price}`)
    .join("\n");

  // Address can come from shipping_address OR billing_address depending on
  // checkout type (pickup orders often have no shipping_address at all).
  const addrObj = order.shipping_address || order.billing_address;
  const address = addrObj
    ? `${addrObj.address1 || ""}${addrObj.address2 ? ", " + addrObj.address2 : ""}, ${addrObj.city || ""}`.trim()
    : "No address (pickup or N/A)";

  // Name can come from customer object, shipping/billing address, or be missing
  // entirely on guest/test orders.
  const nameSource =
    order.customer || order.shipping_address || order.billing_address || {};
  const customerName =
    `${nameSource.first_name || ""} ${nameSource.last_name || ""}`.trim() ||
    order.contact_email ||
    order.email ||
    "Guest";

  // Phone can be on the order itself, the shipping/billing address, or the
  // customer object - check all of them.
  const customerPhone =
    order.phone ||
    (order.shipping_address && order.shipping_address.phone) ||
    (order.billing_address && order.billing_address.phone) ||
    (order.customer && order.customer.phone) ||
    "Not provided";

  return (
    `🛎️ *New Order - Kurly Katch* #${order.order_number}\n\n` +
    `*Customer:* ${customerName}\n` +
    `*Phone:* ${customerPhone}\n` +
    `*Address:* ${address}\n\n` +
    `*Items:*\n${items}\n\n` +
    `*Total:* Rs.${order.total_price}\n` +
    `*Payment:* ${order.financial_status}\n`
  );
}

function buildCustomerMessage(order) {
  const nameSource =
    order.customer || order.shipping_address || order.billing_address || {};
  const customerName = nameSource.first_name || "there";

  return (
    `Hi ${customerName}! 👋 Thank you for your order from *Kurly Katch* (#${order.order_number}).\n\n` +
    `Your total is Rs.${order.total_price}. We're preparing it now and will notify you when it's on the way. ` +
    `For any questions, just reply to this message or call us directly.`
  );
}

// ---------- Send a free-text WhatsApp message (manager only - has an open session) ----------
async function sendWhatsAppMessage(to, body) {
  if (!to) {
    console.log("Skipped sending - no destination number provided.");
    return;
  }
  await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
    body,
  });
}

// ---------- Send an approved WhatsApp TEMPLATE message (required for customers) ----------
// WhatsApp requires the first message to any customer to use a pre-approved
// template. ORDER_CONFIRMATION_TEMPLATE_SID is the "HX..." ID from Twilio
// Content Template Builder after your template is approved.
async function sendWhatsAppTemplate(to, contentSid, variables) {
  if (!to) {
    console.log("Skipped sending - no destination number provided.");
    return;
  }
  await twilioClient.messages.create({
    from: TWILIO_WHATSAPP_FROM,
    to: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
    contentSid,
    contentVariables: JSON.stringify(variables),
  });
}

// ---------- Webhook endpoint ----------
app.post("/webhooks/orders-create", async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      console.warn("Webhook verification failed - rejecting request.");
      return res.status(401).send("Invalid signature");
    }

    const order = req.body;

    // TEMP DEBUG: log the relevant raw fields so we can see exactly what
    // Shopify is sending. Remove this once the name issue is resolved.
    console.log("DEBUG order.customer:", JSON.stringify(order.customer));
    console.log("DEBUG order.shipping_address:", JSON.stringify(order.shipping_address));
    console.log("DEBUG order.billing_address:", JSON.stringify(order.billing_address));
    console.log("DEBUG order.email / contact_email:", order.email, order.contact_email);

    // Respond to Shopify immediately so it doesn't retry/timeout
    res.status(200).send("OK");

    // Send manager notification
    const managerMessage = buildManagerMessage(order);
    await sendWhatsAppMessage(MANAGER_WHATSAPP_NUMBER, managerMessage);

    // Send customer confirmation (only if we have a phone number on the order)
    // Uses an approved WhatsApp template since this is the first message to
    // the customer and free-form text isn't allowed outside an active session.
    const customerPhone =
      order.phone ||
      (order.shipping_address && order.shipping_address.phone) ||
      (order.billing_address && order.billing_address.phone) ||
      (order.customer && order.customer.phone);
    if (customerPhone) {
      const nameSource =
        order.customer || order.shipping_address || order.billing_address || {};
      const firstName = nameSource.first_name || "there";

      await sendWhatsAppTemplate(customerPhone, ORDER_CONFIRMATION_TEMPLATE_SID, {
        1: firstName,
        2: String(order.order_number),
        3: String(order.total_price),
      });
    }

    console.log(`Order #${order.order_number} processed and WhatsApp messages sent.`);
  } catch (err) {
    console.error("Error processing webhook:", err);
    // Note: response already sent above, so we just log here
  }
});

// Simple health check route
app.get("/", (req, res) => res.send("Kurly Katch WhatsApp order bot is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
