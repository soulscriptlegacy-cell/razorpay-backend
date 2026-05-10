const Sentry = require("@sentry/node")

if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || "production",
        tracesSampleRate: 0.1,
        profilesSampleRate: 0.1,
    })
    console.log("✅ Sentry initialized")
}

// index.js (SoulScript Legacy backend)
// Phase 1 additions:
// - GET /admin/orders/:id/download-story (story as .txt download)
// - GET /admin/orders/:id/download-voice-notes (all voice notes as zip)
// - GET /admin/orders/:id/download-cover-material (cover photo OR refs + notes as zip)
// - POST /admin/orders/:id/upload-review-files now accepts optional title + author_name
//   to fill in if customer didn't provide them in story intake

const express = require("express")
const Razorpay = require("razorpay")
const crypto = require("crypto")
const { Readable } = require("stream")
const cors = require("cors")
const multer = require("multer")
const archiver = require("archiver")
const { Resend } = require("resend")
const { createClient } = require("@supabase/supabase-js")

const app = express()

if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app)
}

const WHITE_LABELING_PRICE = 2000
const EXTRA_WRITING_PRICE_PER_WORD = 1

const REVIEW_NOTIFICATION_EMAIL = process.env.REVIEW_NOTIFICATION_EMAIL || "chandan@soulscriptlegacy.com"

const DELHIVERY_API_TOKEN = process.env.DELHIVERY_API_TOKEN || ""
const DELHIVERY_BASE_URL = process.env.DELHIVERY_BASE_URL || "https://track.delhivery.com"
const DELHIVERY_PICKUP_NAME = process.env.DELHIVERY_PICKUP_NAME || ""

const CHAT_IMAGE_MAX_PER_MESSAGE = 10
const CHAT_IMAGE_MAX_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB
const CHAT_IMAGE_ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"])

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
})

const chatImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: CHAT_IMAGE_MAX_SIZE_BYTES,
    files: CHAT_IMAGE_MAX_PER_MESSAGE,
  },
  fileFilter: (req, file, cb) => {
    if (CHAT_IMAGE_ALLOWED_MIME.has(file.mimetype)) {
      cb(null, true)
    } else {
      cb(new Error("Only JPG, PNG, or WEBP images are allowed."))
    }
  },
})

/* =========================
   BASIC MIDDLEWARE
========================= */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
)

app.use(express.json({ limit: "50mb" }))

/* =========================
   HELPERS
========================= */
const must = (key) => {
  const v = process.env[key]
  if (!v) console.warn(`⚠️ Missing env var: ${key}`)
  return v
}

const rateLimitStore = new Map()

function cleanupRateLimits() {
    const now = Date.now()
    for (const [key, entry] of rateLimitStore.entries()) {
        if (entry.resetAt < now) rateLimitStore.delete(key)
    }
}

setInterval(cleanupRateLimits, 60 * 1000)

function rateLimit({ windowMs, maxRequests, keyPrefix = "global" }) {
    return (req, res, next) => {
        const ip = req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress || "unknown"
        const ipFirst = String(ip).split(",")[0].trim()
        const key = `${keyPrefix}:${ipFirst}`

        const now = Date.now()
        const entry = rateLimitStore.get(key)

        if (!entry || entry.resetAt < now) {
            rateLimitStore.set(key, { count: 1, resetAt: now + windowMs })
            return next()
        }

        if (entry.count >= maxRequests) {
            const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
            res.setHeader("Retry-After", retryAfter)
            return res.status(429).json({
                error: "Too many requests. Please slow down.",
                retryAfterSeconds: retryAfter,
            })
        }

        entry.count += 1
        return next()
    }
}

const safeErr = (e) => {
  const obj = {
    message: e?.message || String(e),
    name: e?.name,
    statusCode: e?.statusCode || e?.status,
  }

  if (e?.response) obj.response = e.response
  if (e?.cause) obj.cause = e.cause
  if (e?.stack) obj.stack = e.stack.split("\n").slice(0, 6).join("\n")

  return obj
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase()
}

function createToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex")
}

function createOtp() {
  return String(crypto.randomInt(100000, 1000000))
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function nl2br(value) {
  return escapeHtml(value).replace(/\n/g, "<br />")
}

function hashOtp(email, otp) {
  const secret =
    process.env.OTP_SECRET ||
    process.env.RAZORPAY_KEY_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "soulscript-otp-fallback-secret"

  return crypto
    .createHmac("sha256", secret)
    .update(`${normalizeEmail(email)}:${String(otp).trim()}`)
    .digest("hex")
}

function normalizeText(value, max = 5000) {
  const text = String(value || "").trim()
  return text.slice(0, max)
}

function normalizePincode(value) {
    return String(value || "").trim()
}

function isValidPincode(value) {
    return /^\d{6}$/.test(normalizePincode(value))
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  )
}

function getRazorpayPublicKey() {
  return RAZORPAY_KEY_ID
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ""
}

function normalizeStringArray(value, fallback = [], maxItems = 3) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, maxItems)
  }

  if (Array.isArray(fallback)) {
    return fallback
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, maxItems)
  }

  return []
}

function normalizeStoragePathArray(value, maxItems = 20) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, maxItems)
  }

  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return []

    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return normalizeStoragePathArray(parsed, maxItems)
    } catch {}

    return [trimmed].slice(0, maxItems)
  }

  return []
}

function safeJsonObject(value) {
  if (!value) return {}

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
      return parsed
    } catch {
      return {}
    }
  }

  if (typeof value !== "object" || Array.isArray(value)) return {}
  return value
}

function containsUltraPriority(value) {
  const text = String(value || "").toLowerCase()
  return text.includes("ultra")
}

function addonLooksUltraPriority(addon) {
  if (!addon) return false

  const metadata = safeJsonObject(addon.metadata)
  const metadataText = JSON.stringify(metadata).toLowerCase()

  return (
    containsUltraPriority(addon.addon_type) ||
    containsUltraPriority(addon.description) ||
    metadata.ultraPriority === true ||
    metadata.ultraPriority === "true" ||
    metadata.ultraPriority === "yes" ||
    metadata.ultra_priority === true ||
    metadata.ultra_priority === "true" ||
    metadata.ultra_priority === "yes" ||
    metadataText.includes("ultrapriority") ||
    metadataText.includes("ultra_priority") ||
    metadataText.includes("ultra priority")
  )
}

function addonIsPaid(addon) {
  return addon?.status === "paid" || addon?.payment_status === "paid"
}

function addonAmount(addon) {
  const amount = Number(addon?.amount || 0)
  return Number.isFinite(amount) ? amount : 0
}

function emailParagraph(html) {
  return `
    <div style="font-size:16px;line-height:1.7;color:#111111;margin:0 0 18px;">
      ${html}
    </div>
  `
}

function emailMuted(html) {
  return `
    <div style="font-size:13px;line-height:1.7;color:#666666;margin:0 0 28px;">
      ${html}
    </div>
  `
}

function emailDivider() {
  return `<div style="height:1px;background:#eeeeee;margin:34px 0;"></div>`
}

function emailDetails(rows = []) {
  const cleanRows = rows.filter((row) => row && row.label)
  if (!cleanRows.length) return ""

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 34px;border-collapse:collapse;">
      ${cleanRows
        .map(
          (row) => `
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #eeeeee;width:42%;font-size:12px;line-height:1.5;color:#777777;text-transform:uppercase;letter-spacing:0.8px;vertical-align:top;">
                ${escapeHtml(row.label)}
              </td>
              <td style="padding:10px 0;border-bottom:1px solid #eeeeee;font-size:14px;line-height:1.55;color:#111111;vertical-align:top;">
                ${row.html ? row.value : escapeHtml(row.value)}
              </td>
            </tr>
          `
        )
        .join("")}
    </table>
  `
}

function brandedEmailTemplate({
  title,
  bodyHtml,
  ctaLabel,
  ctaUrl,
  footerHtml = "",
}) {
  const safeTitle = escapeHtml(title || "SoulScript Legacy")
  const safeCtaUrl = ctaUrl ? escapeHtml(ctaUrl) : ""

  const ctaHtml =
    ctaLabel && ctaUrl
      ? `
        <div style="margin:34px 0 38px;">
          <a href="${safeCtaUrl}" target="_blank" style="display:inline-block;background:#0E0E0E;color:#ffffff;padding:13px 18px;text-decoration:none;font-size:13px;letter-spacing:0.4px;">
            ${escapeHtml(ctaLabel)}
          </a>
        </div>
        <div style="font-size:13px;line-height:1.7;color:#666666;margin:0 0 42px;">
          If the button does not open, copy this link into your browser:<br />
          <a href="${safeCtaUrl}" target="_blank" style="color:#666666;text-decoration:underline;word-break:break-all;">
            ${safeCtaUrl}
          </a>
        </div>
      `
      : ""

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </head>
      <body style="margin:0;padding:0;background:#f3f3f3;font-family:Arial, Helvetica, sans-serif;color:#111111;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f3f3;margin:0;padding:0;">
          <tr>
            <td align="center" style="padding:42px 16px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;margin:0 auto;color:#111111;">
                <tr>
                  <td align="center" style="padding:46px 38px 52px;background:#ffffff;color:#111111;">
                    <div style="font-family:Georgia, 'Times New Roman', serif;font-size:20px;font-weight:500;letter-spacing:5px;color:#0E0E0E;line-height:1;text-transform:uppercase;">
                      SOULSCRIPT
                    </div>
                    <div style="font-family:Arial, Helvetica, sans-serif;font-size:8.5px;font-weight:300;letter-spacing:5.5px;color:rgba(14,14,14,0.65);line-height:1;text-transform:uppercase;margin-top:7px;">
                      LEGACY
                    </div>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding-top:72px;text-align:left;background:#ffffff;color:#111111;">
                          <div style="font-size:18px;line-height:1.4;font-weight:700;color:#111111;margin:0 0 46px;">
                            ${safeTitle}
                          </div>

                          ${bodyHtml || ""}
                          ${ctaHtml}

                          <div style="font-size:16px;line-height:1.35;color:#111111;margin:0 0 82px;">
                            Best regards,<br />
                            SoulScript Legacy
                          </div>

                          ${footerHtml || ""}

                          <div style="font-size:13px;line-height:1.6;color:#8a8a8a;margin:0;">
                            <a href="${escapeHtml(PORTAL_BASE_URL)}/privacy" target="_blank" style="color:#8a8a8a;text-decoration:underline;">PRIVACY POLICY</a>
                            <span style="color:#8a8a8a;"> · </span>
                            <a href="${escapeHtml(PORTAL_BASE_URL)}/terms" target="_blank" style="color:#8a8a8a;text-decoration:underline;">Terms and Conditions</a>
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `
}

async function sendEmailSafe({ to, subject, html }) {
  try {
    const r = await resend.emails.send({
      from: EMAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    })
    return { ok: true, response: r }
  } catch (e) {
    console.error(`❌ Email failed: ${subject}`, safeErr(e))
    return { ok: false, error: safeErr(e) }
  }
}

async function delhiveryRequest(path, options = {}) {
    if (!DELHIVERY_API_TOKEN) {
        throw new Error("DELHIVERY_API_TOKEN not configured")
    }

    const url = `${DELHIVERY_BASE_URL}${path}`
    const headers = {
        "Authorization": `Token ${DELHIVERY_API_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        ...(options.headers || {}),
    }

    const response = await fetch(url, {
        ...options,
        headers,
    })

    const text = await response.text()
    let body
    try {
        body = text ? JSON.parse(text) : {}
    } catch {
        body = { raw: text }
    }

    if (!response.ok) {
        console.error("Delhivery API error:", { url, status: response.status, body })
        throw new Error(body?.error || body?.rmk || `Delhivery API ${response.status}`)
    }

    return body
}

function buildDelhiveryShipmentPayload(order) {
    const customerName = String(order.name || "Customer").trim()
    const phone = String(order.phone || "").replace(/\D/g, "").slice(-10)
    const pincode = String(order.pincode || "").replace(/\D/g, "")
    const address = String(order.address || "").slice(0, 250)

    if (!pincode || pincode.length !== 6) {
        throw new Error("Order pincode is missing or invalid")
    }
    if (!phone || phone.length !== 10) {
        throw new Error("Order phone is missing or invalid")
    }

    return {
        shipments: [
            {
                name: customerName,
                add: address,
                pin: pincode,
                country: "India",
                phone: phone,
                order: order.razorpay_order_id || order.id,
                payment_mode: "Prepaid",
                return_pin: "",
                return_city: "",
                return_phone: "",
                return_add: "",
                return_state: "",
                return_country: "",
                products_desc: "Personalized printed novel",
                hsn_code: "",
                cod_amount: "",
                order_date: null,
                total_amount: String(order.total_order_value || order.amount || 0),
                seller_add: "",
                seller_name: "SoulScript Legacy",
                seller_inv: "",
                quantity: "1",
                waybill: "",
                shipment_width: "20",
                shipment_height: "5",
                weight: "500",
                shipping_mode: "Express",
                address_type: "home",
            },
        ],
        pickup_location: {
            name: DELHIVERY_PICKUP_NAME,
        },
    }
}

/* =========================
   SUPABASE
========================= */
const supabase = createClient(
  must("SUPABASE_URL"),
  must("SUPABASE_SERVICE_ROLE_KEY")
)

/* =========================
   STORAGE
========================= */
const STORAGE_BUCKETS = {
  voiceNotes: process.env.SUPABASE_VOICE_NOTES_BUCKET || "order_voice_notes",
  coverPhotos: process.env.SUPABASE_COVER_PHOTOS_BUCKET || "cover-photos",
  coverReferences:
    process.env.SUPABASE_COVER_REFERENCES_BUCKET || "cover-references",
  reviewFiles: process.env.SUPABASE_REVIEW_FILES_BUCKET || "review-files",
  reviewMedia: process.env.SUPABASE_REVIEW_MEDIA_BUCKET || "review-media",
  polaroids: process.env.SUPABASE_POLAROIDS_BUCKET || "polaroid-photos",
  revisionChatMedia: process.env.SUPABASE_REVISION_CHAT_MEDIA_BUCKET || "revision_chat_media",
}

function cleanStoragePath(path) {
  const text = String(path || "").trim()
  if (!text) return ""
  if (/^https?:\/\//i.test(text)) return text
  return text.replace(/^\/+/, "")
}

async function createSignedUrl(bucket, path, expiresInSeconds = 3600) {
  const cleanBucket = String(bucket || "").trim()
  const cleanPath = cleanStoragePath(path)

  if (!cleanBucket || !cleanPath) return null
  if (/^https?:\/\//i.test(cleanPath)) return cleanPath

  try {
    const { data, error } = await supabase.storage
      .from(cleanBucket)
      .createSignedUrl(cleanPath, expiresInSeconds)

    if (error) {
      console.error("⚠️ Signed URL failed:", {
        bucket: cleanBucket,
        path: cleanPath,
        error,
      })
      return null
    }

    return data?.signedUrl || null
  } catch (error) {
    console.error("⚠️ Signed URL exception:", {
      bucket: cleanBucket,
      path: cleanPath,
      error: safeErr(error),
    })
    return null
  }
}

async function createSignedUrlWithFallback(buckets, path, expiresInSeconds = 3600) {
  const bucketList = Array.isArray(buckets) ? buckets : [buckets]

  for (const bucket of bucketList) {
    const signedUrl = await createSignedUrl(bucket, path, expiresInSeconds)
    if (signedUrl) return signedUrl
  }

  return null
}

async function createSignedUrlsForPaths(bucket, paths, expiresInSeconds = 3600) {
  const cleanPaths = normalizeStoragePathArray(paths)
  return Promise.all(
    cleanPaths.map(async (path) => ({
      path,
      signed_url: await createSignedUrl(bucket, path, expiresInSeconds),
    }))
  )
}

async function getPublicOrSignedStorageUrl(bucket, path, expiresInSeconds = 3600) {
  const cleanPath = cleanStoragePath(path)
  if (!cleanPath) return null
  if (/^https?:\/\//i.test(cleanPath)) return cleanPath
  return createSignedUrl(bucket, cleanPath, expiresInSeconds)
}

// Download a storage file as Buffer (for zip bundling)
async function downloadStorageFileBuffer(bucket, path) {
  const cleanBucket = String(bucket || "").trim()
  const cleanPath = cleanStoragePath(path)

  if (!cleanBucket || !cleanPath) return null

  try {
    const { data, error } = await supabase.storage.from(cleanBucket).download(cleanPath)
    if (error) {
      console.error("⚠️ Download storage file failed:", {
        bucket: cleanBucket,
        path: cleanPath,
        error,
      })
      return null
    }
    if (!data) return null
    const arrayBuffer = await data.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (error) {
    console.error("⚠️ Download storage file exception:", {
      bucket: cleanBucket,
      path: cleanPath,
      error: safeErr(error),
    })
    return null
  }
}

// Try multiple buckets to find a file (legacy paths may be in different buckets)
async function downloadStorageFileWithFallback(buckets, path) {
  const bucketList = Array.isArray(buckets) ? buckets : [buckets]
  for (const bucket of bucketList) {
    const buffer = await downloadStorageFileBuffer(bucket, path)
    if (buffer) return { buffer, bucket }
  }
  return null
}

function basenameFromPath(path) {
  const cleaned = cleanStoragePath(path)
  if (!cleaned) return ""
  const parts = cleaned.split("/")
  return parts[parts.length - 1] || cleaned
}

async function withSignedVoiceNotes(voiceNotes = []) {
  return Promise.all(
    (voiceNotes || []).map(async (note) => {
      const signedUrl = await createSignedUrl(
        STORAGE_BUCKETS.voiceNotes,
        note.file_path
      )

      return {
        ...note,
        signed_url: signedUrl,
        playable_url: signedUrl,
      }
    })
  )
}

async function withSignedReviewFiles(reviewFiles = []) {
  return Promise.all(
    (reviewFiles || []).map(async (file) => {
      const manuscriptUrl = await createSignedUrl(
        STORAGE_BUCKETS.reviewFiles,
        file.manuscript_pdf_path
      )

      const coverUrl = await createSignedUrl(
        STORAGE_BUCKETS.reviewFiles,
        file.cover_file_path
      )

      return {
        ...file,
        manuscript_pdf_signed_url: manuscriptUrl,
        manuscript_pdf_url: manuscriptUrl,
        cover_file_signed_url: coverUrl,
        cover_file_url: coverUrl,
      }
    })
  )
}

async function withSignedDeliverables(deliverables = []) {
  return Promise.all(
    (deliverables || []).map(async (item) => {
      const pdfUrl = await createSignedUrl(
        STORAGE_BUCKETS.reviewFiles,
        item.pdf_path
      )

      const coverUrl = await createSignedUrl(
        STORAGE_BUCKETS.reviewFiles,
        item.cover_path
      )

      return {
        ...item,
        pdf_signed_url: pdfUrl,
        cover_signed_url: coverUrl,
      }
    })
  )
}

async function withSignedStoryIntake(intake) {
  if (!intake) return null

  const coverPhotoPath = firstNonEmpty(
    intake.cover_photo_path,
    intake.photo_path
  )

  const coverPhotoUrl = await createSignedUrlWithFallback(
    [STORAGE_BUCKETS.reviewMedia, STORAGE_BUCKETS.coverPhotos, STORAGE_BUCKETS.coverReferences],
    coverPhotoPath
  )

  const referencePaths = normalizeStoragePathArray(intake.reference_image_paths, 20)
  const referenceImages = await Promise.all(
    referencePaths.map(async (path) => ({
      file_path: path,
      path,
      signed_url: await createSignedUrlWithFallback(
        [STORAGE_BUCKETS.reviewMedia, STORAGE_BUCKETS.coverReferences, STORAGE_BUCKETS.coverPhotos],
        path
      ),
    }))
  )

  return {
    ...intake,
    cover_photo_signed_url: coverPhotoUrl,
    cover_photo: coverPhotoPath
      ? {
          file_path: coverPhotoPath,
          signed_url: coverPhotoUrl,
        }
      : null,
    reference_image_signed_urls: referenceImages.map((item) => item.signed_url).filter(Boolean),
    reference_images: referenceImages,
  }
}

async function withSignedCoverReferenceImages(images = []) {
  return Promise.all(
    (images || []).map(async (image) => {
      const imagePath = image.file_path || image.path

      const signedUrl = await createSignedUrlWithFallback(
        [
          STORAGE_BUCKETS.reviewMedia,
          STORAGE_BUCKETS.coverReferences,
          STORAGE_BUCKETS.coverPhotos,
        ],
        imagePath
      )

      return {
        ...image,
        signed_url: signedUrl,
        url: signedUrl,
        file_url: signedUrl,
        download_url: signedUrl,
      }
    })
  )
}

async function withSignedPolaroids(images = []) {
  return Promise.all(
    (images || []).map(async (image) => ({
      ...image,
      signed_url: await createSignedUrl(
        STORAGE_BUCKETS.polaroids,
        image.file_path
      ),
    }))
  )
}

function safeFileName(name) {
  const fallback = `file-${Date.now()}`
  const clean = String(name || fallback)
    .trim()
    .replace(/[/\\]/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 140)

  return clean || fallback
}

function fileExtensionFor(file, fallback = "bin") {
  const name = String(file?.originalname || "")
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : ""
  if (ext) return ext

  if (file?.mimetype === "application/pdf") return "pdf"
  if (file?.mimetype === "image/jpeg") return "jpg"
  if (file?.mimetype === "image/png") return "png"
  if (file?.mimetype === "image/webp") return "webp"

  return fallback
}

function uploadedFile(req, names) {
  for (const name of names) {
    const value = req.files?.[name]
    if (Array.isArray(value) && value[0]) return value[0]
  }
  return null
}

async function uploadRevisionChatImage(orderId, file) {
  if (!file) return null

  const timestamp = Date.now()
  const extension = fileExtensionFor(file, "jpg")
  const name = safeFileName(file.originalname || `chat-image.${extension}`)
  const path = `${orderId}/${timestamp}-${Math.random().toString(36).slice(2, 8)}-${name}`

  const { error } = await supabase.storage
    .from(STORAGE_BUCKETS.revisionChatMedia)
    .upload(path, file.buffer, {
      contentType: file.mimetype || "image/jpeg",
      upsert: false,
    })

  if (error) {
    console.error("❌ Chat image upload failed:", { path, error })
    throw new Error("Could not upload chat image.")
  }

  return path
}

async function withSignedChatMessages(messages = []) {
  return Promise.all(
    (messages || []).map(async (msg) => {
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : []
      const signedAttachments = await Promise.all(
        attachments.map(async (att) => {
          const path = typeof att === "string" ? att : att?.path
          if (!path) return att
          const signedUrl = await createSignedUrl(STORAGE_BUCKETS.revisionChatMedia, path)
          return {
            path,
            file_name: typeof att === "object" ? att?.file_name || basenameFromPath(path) : basenameFromPath(path),
            signed_url: signedUrl,
          }
        })
      )
      return {
        ...msg,
        attachments: signedAttachments,
      }
    })
  )
}

async function getNextReviewVersion(orderId) {
  const { data, error } = await supabase
    .from("review_files")
    .select("version_number")
    .eq("order_id", orderId)
    .order("version_number", { ascending: false })
    .limit(1)

  if (error) {
    console.error("⚠️ Failed to get next review version:", error)
    return 1
  }

  const current = Number(data?.[0]?.version_number || 0)
  return Number.isFinite(current) ? current + 1 : 1
}

async function uploadReviewStorageFile(orderId, versionNumber, file, label) {
  if (!file) return null

  const timestamp = Date.now()
  const extension = fileExtensionFor(file)
  const name = safeFileName(file.originalname || `${label}.${extension}`)
  const path = `${orderId}/reviews/version-${versionNumber}/${label}-${timestamp}-${name}`

  const { error } = await supabase.storage
    .from(STORAGE_BUCKETS.reviewFiles)
    .upload(path, file.buffer, {
      contentType: file.mimetype || "application/octet-stream",
      upsert: false,
    })

  if (error) {
    console.error("❌ Review file upload failed:", {
      bucket: STORAGE_BUCKETS.reviewFiles,
      path,
      error,
    })
    throw new AdminInputError(`Could not upload ${label} file.`)
  }

  return path
}

function sanitizeManagerAddon(addon) {
  return {
    id: addon.id,
    order_id: addon.order_id,
    addon_type: addon.addon_type,
    title: addon.title,
    description: addon.description,
    quantity: addon.quantity,
    unit_price: addon.unit_price,
    amount: addon.amount,
    status: addon.status,
    payment_status: addon.payment_status,
    paid_at: addon.paid_at,
    created_at: addon.created_at,
  }
}

/* =========================
   RESEND
========================= */
const resend = new Resend(must("RESEND_API_KEY"))

const EMAIL_FROM =
  process.env.EMAIL_FROM || "SoulScript Legacy <hello@soulscriptlegacy.com>"

const PORTAL_BASE_URL =
  process.env.PORTAL_BASE_URL || "https://soulscriptlegacy.com"

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "soulscriptlegacy@gmail.com"

/* =========================
   RAZORPAY
========================= */
const RAZORPAY_MODE = (process.env.RAZORPAY_MODE || "live").toLowerCase()
const RAZORPAY_USE_TEST = RAZORPAY_MODE === "test"

const RAZORPAY_KEY_ID = RAZORPAY_USE_TEST
    ? (process.env.RAZORPAY_KEY_ID_TEST || must("RAZORPAY_KEY_ID"))
    : must("RAZORPAY_KEY_ID")

const RAZORPAY_KEY_SECRET = RAZORPAY_USE_TEST
    ? (process.env.RAZORPAY_KEY_SECRET_TEST || must("RAZORPAY_KEY_SECRET"))
    : must("RAZORPAY_KEY_SECRET")

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
})

const AIRTABLE_WEBHOOK_SECRET = process.env.AIRTABLE_WEBHOOK_SECRET || ""

/* =========================
   CUSTOMER ACCOUNT HELPERS
========================= */
const ACCOUNT_SESSION_DAYS = 180
const OTP_EXPIRY_MINUTES = 10

async function getCustomerFromSession(req) {
  const authHeader = String(req.header("Authorization") || "")

  if (!authHeader.startsWith("Bearer ")) {
    return { error: "Missing account session", status: 401 }
  }

  const sessionToken = authHeader.replace("Bearer ", "").trim()

  if (!sessionToken) {
    return { error: "Missing account session", status: 401 }
  }

  const { data: session, error } = await supabase
    .from("customer_sessions")
    .select("*")
    .eq("session_token", sessionToken)
    .eq("revoked", false)
    .single()

  if (error || !session) {
    return { error: "Invalid or expired account session", status: 401 }
  }

  await supabase
    .from("customer_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", session.id)

  return {
    email: normalizeEmail(session.email),
    session,
  }
}

/* =========================
   PRICING RULES
========================= */
const EDITION_PRICES = {
  "Breeze Edition": 2,
  "Confession Edition": 1999,
  "Classic Edition": 2599,
  "Essence Edition": 3499,
}

const ULTRA_PRIORITY_PRICE = 1000

const ADDON_PRICES = {
  voice_note_hour: 349,
  custom_cover: 499,
  extra_softcover_copy: 399,
  extra_hardcover_copy: 499,
  extra_polaroids_pack: 299,
  white_labeling: 2000,
}

function calculateCheckoutAmount({ edition, paymentType, ultraPriority }) {
  const basePrice = EDITION_PRICES[edition]

  if (!basePrice) {
    throw new Error(`Invalid or unpriced edition: ${edition}`)
  }

  const addOnsTotal = ultraPriority ? ULTRA_PRIORITY_PRICE : 0
  const totalOrderValue = basePrice + addOnsTotal

  const amountToPay =
    paymentType === "PREPAID"
      ? totalOrderValue
      : Math.ceil(totalOrderValue / 2)

  const pendingAmount = totalOrderValue - amountToPay

  return {
    basePrice,
    addOnsTotal,
    totalOrderValue,
    amountToPay,
    pendingAmount,
  }
}

function getIncludedVoiceSeconds(edition) {
  if (edition === "Classic Edition") return 30 * 60
  if (edition === "Essence Edition") return 60 * 60
  return 0
}

function getReviewTimeline(edition) {
  if (edition === "Essence Edition") return "12 to 16 working days"
  return "8 to 12 working days"
}

function getAddonAmount({ addonType, quantity = 1, customAmount }) {
  const qty = Math.max(1, Number(quantity || 1))

  if (addonType === "voice_note_hour") return ADDON_PRICES.voice_note_hour * qty
  if (addonType === "custom_cover") return ADDON_PRICES.custom_cover
  if (addonType === "extra_softcover_copy") return ADDON_PRICES.extra_softcover_copy * qty
  if (addonType === "extra_hardcover_copy") return ADDON_PRICES.extra_hardcover_copy * qty
  if (addonType === "extra_polaroids_pack") return ADDON_PRICES.extra_polaroids_pack * qty
  if (addonType === "white_labeling") return ADDON_PRICES.white_labeling

  if (addonType === "revision_charge") {
    const amount = Number(customAmount || 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Valid revision amount required")
    }
    return amount
  }

  if (addonType === "balance_payment") {
    const amount = Number(customAmount || 0)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Valid balance amount required")
    }
    return amount
  }

  throw new Error(`Invalid add-on type: ${addonType}`)
}

async function getOrderByIdOrRazorpay(orderId) {
  const clean = String(orderId || "").trim()
  if (!clean) return null

  let query = supabase.from("orders").select("*")

  if (isUuid(clean)) query = query.eq("id", clean)
  else query = query.eq("razorpay_order_id", clean)

  const { data, error } = await query.single()
  if (error || !data) return null
  return data
}

async function refreshOrderTotals(orderId) {
  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .single()

  if (orderErr || !order) return null

  const editionBasePrice =
    EDITION_PRICES[order.edition] ||
    Number(order.total_order_value || order.amount || 0)

  const { data: addonRows } = await supabase
    .from("order_addons")
    .select("addon_type, amount, status, payment_status, metadata")
    .eq("order_id", orderId)

  const paidAddons = (addonRows || []).filter(addonIsPaid)

  const orderValueAddonTotal = paidAddons.reduce((sum, addon) => {
    if (addon.addon_type === "balance_payment") return sum
    return sum + addonAmount(addon)
  }, 0)

  const paidPostCheckoutAddonTotal = paidAddons.reduce((sum, addon) => {
    if (addon.addon_type === "ultra_priority") return sum
    return sum + addonAmount(addon)
  }, 0)

  const paidAmount = Number(order.amount || 0) + paidPostCheckoutAddonTotal
  const totalOrderValue = editionBasePrice + orderValueAddonTotal
  const balanceDue = Math.max(0, totalOrderValue - paidAmount)

  await supabase
    .from("orders")
    .update({
      total_order_value: totalOrderValue,
      paid_amount: paidAmount,
      balance_due: balanceDue,
      pending_amount: balanceDue,
    })
    .eq("id", orderId)

  return { totalOrderValue, paidAmount, balanceDue }
}

/* =========================
   STORY INTAKE DRAFT HELPERS
========================= */
async function getStoryIntakesForOrder(orderId) {
  const { data, error } = await supabase
    .from("story_intakes")
    .select("*")
    .eq("order_id", orderId)
    .order("updated_at", { ascending: false })

  if (error) {
    console.error("❌ getStoryIntakesForOrder failed:", error)
    return []
  }

  return data || []
}

async function getActiveStoryIntake(orderId) {
  const intakes = await getStoryIntakesForOrder(orderId)

  if (!intakes.length) return null

  const draft = intakes.find(
    (item) => item.submitted !== true && !item.submitted_at
  )

  if (draft) return draft

  return intakes[0] || null
}

async function upsertStoryIntakeDraft(order, draft = {}) {
  const existingIntake = await getActiveStoryIntake(order.id)

  const fallbackStory =
    draft.textStory ?? order.story ?? existingIntake?.text_story ?? ""

  const cleanStory = normalizeText(fallbackStory, 80000)

  const incomingCoverPhotoPath =
    draft.coverPhotoPath === undefined || draft.coverPhotoPath === null
      ? undefined
      : String(draft.coverPhotoPath).trim()

  const coverPhotoPathToSave =
    incomingCoverPhotoPath !== undefined
      ? normalizeText(incomingCoverPhotoPath, 1200) || null
      : existingIntake?.cover_photo_path || null

  const payload = {
    order_id: order.id,

    text_story: cleanStory,

    word_count: Number(
      draft.wordCount ??
        existingIntake?.word_count ??
        cleanStory.split(/\s+/).filter(Boolean).length
    ),

    tone:
      normalizeText(firstNonEmpty(draft.tone, existingIntake?.tone), 120) ||
      null,

    writer_note:
      normalizeText(
        firstNonEmpty(
          draft.noteToWriter,
          draft.writerNote,
          existingIntake?.writer_note
        ),
        3500
      ) || null,

    cover_mode:
      normalizeText(
        firstNonEmpty(
          draft.coverType,
          draft.coverMode,
          existingIntake?.cover_mode
        ),
        80
      ) || null,

    custom_cover_notes:
      normalizeText(
        firstNonEmpty(
          draft.coverNotes,
          draft.customCoverNotes,
          existingIntake?.custom_cover_notes
        ),
        3500
      ) || null,

    title:
      normalizeText(
        firstNonEmpty(draft.coverTitle, draft.title, existingIntake?.title),
        300
      ) || null,

    author_name:
      normalizeText(
        firstNonEmpty(draft.authorName, existingIntake?.author_name),
        180
      ) || null,

    cover_photo_path: coverPhotoPathToSave,

    reference_image_paths: normalizeStringArray(
      draft.referenceImagePaths,
      existingIntake?.reference_image_paths,
      3
    ),

    voice_choice:
      normalizeText(
        firstNonEmpty(
          draft.essenceInputChoice,
          draft.voiceChoice,
          existingIntake?.voice_choice
        ),
        40
      ) || null,

    essence_input_choice:
      normalizeText(
        firstNonEmpty(
          draft.essenceInputChoice,
          draft.voiceChoice,
          existingIntake?.essence_input_choice
        ),
        40
      ) || null,

    updated_at: new Date().toISOString(),
  }

  if (
    existingIntake &&
    existingIntake.submitted !== true &&
    !existingIntake.submitted_at
  ) {
    const { data, error } = await supabase
      .from("story_intakes")
      .update(payload)
      .eq("id", existingIntake.id)
      .select("*")
      .single()

    if (error) {
      console.error("❌ Story intake draft update failed:", error)
      throw new Error("Could not save intake draft")
    }

    return data
  }

  const { data, error } = await supabase
    .from("story_intakes")
    .insert({
      ...payload,
      submitted: false,
      submitted_at: null,
    })
    .select("*")
    .single()

  if (error) {
    console.error("❌ Story intake draft insert failed:", error)
    throw new Error("Could not create intake draft")
  }

  return data
}

/* =========================
   PRICING QUOTE
========================= */
app.post("/quote", (req, res) => {
  try {
    const { edition, paymentType = "PREPAID", ultraPriority = false } = req.body

    if (!edition) {
      return res.status(400).json({ error: "Edition required" })
    }

    const pricing = calculateCheckoutAmount({
      edition,
      paymentType,
      ultraPriority: !!ultraPriority,
    })

    return res.json({
      success: true,
      ...pricing,
      ultraPriorityPrice: ULTRA_PRIORITY_PRICE,
    })
  } catch (err) {
    console.error("❌ /quote failed:", safeErr(err))
    return res.status(400).json({ error: err?.message || "Quote failed" })
  }
})

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  return res.json({
    ok: true,
    time: new Date().toISOString(),
    razorpayMode: RAZORPAY_MODE,
    portalBase: PORTAL_BASE_URL,
    emailFrom: EMAIL_FROM,
    adminEmail: ADMIN_EMAIL,
    pricing: EDITION_PRICES,
    addOns: ADDON_PRICES,
    addonPrices: ADDON_PRICES,
    accountLogin: "email_otp",
    otpExpiryMinutes: OTP_EXPIRY_MINUTES,
    storageBuckets: STORAGE_BUCKETS,
    delhivery: {
      configured: Boolean(DELHIVERY_API_TOKEN),
      pickupName: DELHIVERY_PICKUP_NAME,
      baseUrl: DELHIVERY_BASE_URL,
    },
    phase1Endpoints: [
      "GET /admin/orders/:id/download-story",
      "GET /admin/orders/:id/download-voice-notes",
      "GET /admin/orders/:id/download-cover-material",
    ],
    phase2Endpoints: [
      "POST /story/create-balance-payment",
      "POST /story/confirm-balance-payment",
      "POST /story/create-cart-payment",
      "POST /story/confirm-cart-payment",
      "POST /story/upload-polaroid-photo",
      "POST /portal/revision-chat-message",
      "GET /portal/revision-chat-messages",
      "POST /portal/revision-chat-upload-image",
      "GET /admin/orders/:id/revision-chat-messages",
      "POST /admin/orders/:id/revision-chat-message",
    ],
    phase3Endpoints: [
      "POST /story/create-extra-writing",
      "POST /story/confirm-extra-writing",
      "GET /admin/extra-writing-requests",
      "PATCH /admin/extra-writing-requests/:id",
      "POST /admin/orders/:id/delhivery-create-shipment",
      "GET /admin/orders/:id/delhivery-label",
      "GET /admin/orders/:id/delhivery-tracking",
      "POST /webhooks/delhivery-status",
    ],
    whiteLabelingPrice: WHITE_LABELING_PRICE,
    reviewNotificationEmail: REVIEW_NOTIFICATION_EMAIL,
  })
})

/* =========================
   AIRTABLE DISPATCH HOOK
========================= */
app.post("/hooks/dispatch", async (req, res) => {
  try {
    const secret = String(req.header("x-hook-secret") || "").trim()

    if (!AIRTABLE_WEBHOOK_SECRET) {
      console.warn("⚠️ AIRTABLE_WEBHOOK_SECRET missing in env")
      return res.status(500).json({ ok: false, error: "Server not configured" })
    }

    if (secret !== AIRTABLE_WEBHOOK_SECRET) {
      return res.status(401).json({ ok: false, error: "Unauthorized" })
    }

    console.log("✅ Dispatch hook hit:", req.body)

    const recordId = String(req.body?.recordId || "").trim()
    if (!recordId) {
      return res.status(400).json({ ok: false, error: "recordId missing" })
    }

    return res.json({ ok: true, received: { recordId } })
  } catch (e) {
    console.error("❌ /hooks/dispatch error:", safeErr(e))
    return res.status(500).json({ ok: false, error: safeErr(e) })
  }
})

/* =========================
   DEBUG RESEND
========================= */
app.get("/debug/email", async (req, res) => {
  try {
    const to = String(req.query.to || ADMIN_EMAIL).trim().toLowerCase()

    const r = await resend.emails.send({
      from: EMAIL_FROM,
      to: [to],
      subject: "Resend test (SoulScript)",
      html: brandedEmailTemplate({
        title: "Resend test",
        bodyHtml:
          emailParagraph("If you received this email, Resend is working correctly for SoulScript Legacy.") +
          emailDetails([
            { label: "Time", value: new Date().toISOString() },
            { label: "Recipient", value: to },
          ]),
      }),
    })

    return res.json({ success: true, to, resend: r })
  } catch (e) {
    const err = safeErr(e)
    console.error("❌ /debug/email failed:", err)
    return res.status(500).json({ success: false, error: err })
  }
})

/* =========================
   CREATE RAZORPAY ORDER
========================= */
app.post("/create-order", async (req, res) => {
  try {
    const { edition, productSlug, paymentType, ultraPriority, customer } =
      req.body

    if (!edition || !paymentType || !customer) {
      return res.status(400).json({ error: "Missing checkout data" })
    }

    if (
      !customer.name ||
      !customer.phone ||
      !customer.email ||
      !customer.address
    ) {
      return res.status(400).json({ error: "Customer details missing" })
    }

    if (!isValidPincode(customer.pincode)) {
      return res.status(400).json({ error: "Dear, please enter a valid 6-digit pincode." })
    }

    const pincode = normalizePincode(customer.pincode)

    if (!["PREPAID", "ADVANCE"].includes(paymentType)) {
      return res.status(400).json({ error: "Invalid payment type" })
    }

    const pricing = calculateCheckoutAmount({
      edition,
      paymentType,
      ultraPriority: !!ultraPriority,
    })

    const receipt = "ssl_" + Date.now()

    const razorpayOrder = await razorpay.orders.create({
      amount: pricing.amountToPay * 100,
      currency: "INR",
      receipt,
      notes: {
        flow: "main_checkout",
        edition,
        productSlug: productSlug || "",
        paymentType,
        ultraPriority: ultraPriority ? "yes" : "no",
        basePrice: String(pricing.basePrice),
        addOnsTotal: String(pricing.addOnsTotal),
        totalOrderValue: String(pricing.totalOrderValue),
        amountToPay: String(pricing.amountToPay),
        pendingAmount: String(pricing.pendingAmount),
        customerName: customer.name,
        customerEmail: String(customer.email).trim().toLowerCase(),
        customerPhone: customer.phone,
        customerPincode: pincode,
      },
    })

    return res.json({
      success: true,
      keyId: RAZORPAY_KEY_ID,
      razorpayKeyId: RAZORPAY_KEY_ID,
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      amountToPay: pricing.amountToPay,
      totalOrderValue: pricing.totalOrderValue,
      pendingAmount: pricing.pendingAmount,
    })
  } catch (err) {
    console.error("❌ /create-order failed:", safeErr(err))
    return res.status(500).json({
      error: err?.message || "Order creation failed",
    })
  }
})

/* =========================
   CONFIRM PAYMENT
========================= */
app.post("/confirm-payment", async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      customer,
    } = req.body

    if (
      !razorpay_payment_id ||
      !razorpay_order_id ||
      !razorpay_signature ||
      !customer ||
      !customer.name ||
      !customer.phone ||
      !customer.email ||
      !customer.address
    ) {
      return res.status(400).json({ error: "Missing required payment data" })
    }

    if (!isValidPincode(customer.pincode)) {
      return res.status(400).json({ error: "Dear, please enter a valid 6-digit pincode." })
    }

    const pincode = normalizePincode(customer.pincode)

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex")

    if (expectedSignature !== razorpay_signature) {
      console.error("❌ Invalid Razorpay signature")
      return res.status(400).json({ error: "Invalid payment signature" })
    }

    const razorpayOrder = await razorpay.orders.fetch(razorpay_order_id)
    const notes = razorpayOrder.notes || {}

    const edition = notes.edition
    const paymentType = notes.paymentType
    const amountToPay = Number(notes.amountToPay || 0)
    const totalOrderValue = Number(notes.totalOrderValue || 0)
    const pendingAmount = Number(notes.pendingAmount || 0)
    const ultraPriority = notes.ultraPriority === "yes"

    const normalizedEmail = normalizeEmail(customer.email)

    const normalizedPaymentType =
      paymentType === "PREPAID" ? "PREPAID" : "ADVANCE"

    const { data: insertedOrder, error: dbError } = await supabase
      .from("orders")
      .insert([
        {
          razorpay_order_id,
          razorpay_payment_id,
          edition,
          payment_type: normalizedPaymentType,
          amount: amountToPay,
          total_order_value: totalOrderValue || amountToPay,
          paid_amount: amountToPay,
          balance_due: pendingAmount,
          pending_amount: pendingAmount,
          order_status: "story_pending",
          production_status: "story_pending",
          name: customer.name,
          email: normalizedEmail,
          phone: customer.phone,
          address: customer.address,
          pincode,
        },
      ])
      .select("*")
      .single()

    if (dbError) {
      console.error("⚠️ Supabase insert failed:", dbError)
      return res.status(500).json({
        error: "Payment verified but failed to save order",
        details: dbError,
      })
    }

    if (ultraPriority) {
      const { error: addonErr } = await supabase.from("order_addons").insert({
        order_id: insertedOrder.id,
        addon_type: "ultra_priority",
        title: "Ultra Priority",
        description: "Ultra Priority",
        quantity: 1,
        unit_price: ULTRA_PRIORITY_PRICE,
        amount: ULTRA_PRIORITY_PRICE,
        status: "paid",
        payment_status: "paid",
        razorpay_order_id,
        razorpay_payment_id,
        paid_at: new Date().toISOString(),
        metadata: { ultraPriority: true, source: "main_checkout" },
      })

      if (addonErr) {
        console.error("⚠️ Ultra priority add-on insert failed:", addonErr)
      }
    }

    console.log("✅ Order saved to Supabase:", razorpay_order_id)

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `New order confirmed - ${edition}`,
      html: brandedEmailTemplate({
        title: "New order confirmed",
        bodyHtml:
          emailParagraph("A new SoulScript Legacy order has been confirmed.") +
          emailDetails([
            { label: "Edition", value: edition },
            { label: "Payment type", value: normalizedPaymentType === "PREPAID" ? "Paid in full" : "50% Advance" },
            { label: "Amount paid", value: `₹${amountToPay}` },
            { label: "Total order value", value: `₹${totalOrderValue}` },
            { label: "Pending amount", value: `₹${pendingAmount}` },
            { label: "Ultra priority", value: ultraPriority ? "Yes" : "No" },
            { label: "Razorpay payment ID", value: razorpay_payment_id },
            { label: "Razorpay order ID", value: razorpay_order_id },
            { label: "Customer", value: customer.name },
            { label: "Phone", value: customer.phone },
            { label: "Email", value: normalizedEmail },
            { label: "Address", value: nl2br(customer.address), html: true },
          ]),
      }),
    })

    await sendEmailSafe({
      to: normalizedEmail,
      subject: "Your SoulScript Legacy order is confirmed",
      html: brandedEmailTemplate({
        title: "Order confirmed",
        bodyHtml:
          emailParagraph(`Dear ${escapeHtml(customer.name)},`) +
          emailParagraph(`Your ${escapeHtml(edition)} has been booked successfully.`) +
          emailParagraph("You can now open your private story submission portal and submit your details."),
        ctaLabel: "Open Story Portal",
        ctaUrl: `${PORTAL_BASE_URL}/story?order=${encodeURIComponent(razorpay_order_id)}`,
      }),
    })

    return res.json({
      success: true,
      nextUrl: `/story?order=${razorpay_order_id}`,
      razorpayOrderId: razorpay_order_id,
      order: insertedOrder,
    })
  } catch (err) {
    if (typeof Sentry !== "undefined" && process.env.SENTRY_DSN) {
        Sentry.captureException(err, { tags: { endpoint: "confirm-payment" } })
    }
    console.error("❌ /confirm-payment error:", safeErr(err))
    return res.status(500).json({
      error: "Payment confirmation failed",
      details: safeErr(err),
    })
  }
})

/* =========================
   CUSTOMER ACCOUNT OTP LOGIN
========================= */
async function sendAccountOtpForEmail(email, res) {
  const cleanEmail = normalizeEmail(email)

  if (!cleanEmail || !cleanEmail.includes("@")) {
    return res.status(400).json({ error: "Valid email required" })
  }

  const { data: existingOrders, error: orderCheckErr } = await supabase
    .from("orders")
    .select("id, name")
    .eq("email", cleanEmail)
    .order("created_at", { ascending: false })
    .limit(1)

  if (orderCheckErr) {
    console.error("❌ Failed to check customer orders:", orderCheckErr)
    return res.status(500).json({ error: "Could not check account" })
  }

  if (!existingOrders || existingOrders.length === 0) {
    return res.status(404).json({
      error: "No orders found with this email. Please use the email entered during checkout.",
    })
  }

  const customerName =
    String(existingOrders?.[0]?.name || "").trim() || "SoulScript customer"

  const otp = createOtp()
  const otpHash = hashOtp(cleanEmail, otp)
  const expiresAt = new Date(
    Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000
  ).toISOString()

  await supabase
    .from("customer_login_tokens")
    .update({ used: true })
    .eq("email", cleanEmail)
    .eq("used", false)

  const { error: tokenErr } = await supabase
    .from("customer_login_tokens")
    .insert({
      email: cleanEmail,
      token: otpHash,
      expires_at: expiresAt,
      used: false,
    })

  if (tokenErr) {
    console.error("❌ Failed to create account OTP:", tokenErr)
    return res.status(500).json({ error: "Could not create OTP" })
  }

  const html = brandedEmailTemplate({
    title: "Profile code",
    bodyHtml:
      emailParagraph(`Dear ${escapeHtml(customerName)},`) +
      emailParagraph("Below you can find the verification code:") +
      `
        <div style="font-size:26px;line-height:1.2;letter-spacing:2px;font-weight:400;color:#000000;margin:0 0 18px;">
          ${otp}
        </div>
      ` +
      emailParagraph(`This code will expire in ${OTP_EXPIRY_MINUTES} minutes.`),
  })

  try {
    const r = await resend.emails.send({
      from: EMAIL_FROM,
      to: [cleanEmail],
      subject: "Your SoulScript Legacy profile code",
      html,
    })

    console.log("📨 Account OTP email sent:", cleanEmail, r?.id || r)

    return res.json({
      success: true,
      message: "OTP sent to your email",
      email: cleanEmail,
      expiresInMinutes: OTP_EXPIRY_MINUTES,
    })
  } catch (emailErr) {
    console.error("❌ Account OTP email failed:", safeErr(emailErr))

    return res.status(500).json({
      error: "Could not send account OTP email",
      details: safeErr(emailErr),
    })
  }
}

app.post("/account/send-otp", rateLimit({ windowMs: 60 * 60 * 1000, maxRequests: 5, keyPrefix: "otp" }), async (req, res) => {
  try {
    return await sendAccountOtpForEmail(req.body?.email, res)
  } catch (err) {
    console.error("❌ /account/send-otp error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/account/send-login-link", rateLimit({ windowMs: 60 * 60 * 1000, maxRequests: 5, keyPrefix: "otp" }), async (req, res) => {
  try {
    return await sendAccountOtpForEmail(req.body?.email, res)
  } catch (err) {
    console.error("❌ /account/send-login-link alias error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/account/verify-otp", rateLimit({ windowMs: 60 * 60 * 1000, maxRequests: 20, keyPrefix: "verify-otp" }), async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email)
    const otp = String(req.body?.otp || "").trim()

    if (!email || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email required" })
    }

    if (!otp || !/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: "Valid 6-digit OTP required" })
    }

    const { data: tokens, error: tokenErr } = await supabase
      .from("customer_login_tokens")
      .select("*")
      .eq("email", email)
      .eq("used", false)
      .order("expires_at", { ascending: false })
      .limit(1)

    const loginToken = tokens?.[0]

    if (tokenErr || !loginToken) {
      return res.status(401).json({ error: "Invalid or expired OTP" })
    }

    if (new Date(loginToken.expires_at).getTime() < Date.now()) {
      await supabase
        .from("customer_login_tokens")
        .update({ used: true })
        .eq("id", loginToken.id)

      return res.status(410).json({ error: "OTP expired. Please request a new one." })
    }

    const expectedHash = hashOtp(email, otp)

    if (loginToken.token !== expectedHash) {
      return res.status(401).json({ error: "Incorrect OTP" })
    }

    const sessionToken = createToken(40)

    const { error: sessionErr } = await supabase
      .from("customer_sessions")
      .insert({
        email,
        session_token: sessionToken,
        revoked: false,
      })

    if (sessionErr) {
      console.error("❌ Failed to create customer session:", sessionErr)
      return res.status(500).json({ error: "Could not create account session" })
    }

    await supabase
      .from("customer_login_tokens")
      .update({ used: true })
      .eq("id", loginToken.id)

    return res.json({
      success: true,
      email,
      sessionToken,
      expiresInDays: ACCOUNT_SESSION_DAYS,
    })
  } catch (err) {
    console.error("❌ /account/verify-otp error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.get("/account/verify-login", async (req, res) => {
  return res.status(410).json({
    error: "Magic login links are no longer supported. Please request an email OTP.",
  })
})

app.get("/account/me", async (req, res) => {
  try {
    const customer = await getCustomerFromSession(req)

    if (customer.error) {
      return res.status(customer.status || 401).json({ error: customer.error })
    }

    return res.json({ success: true, email: customer.email })
  } catch (err) {
    console.error("❌ /account/me error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.get("/account/orders", async (req, res) => {
  try {
    const customer = await getCustomerFromSession(req)

    if (customer.error) {
      return res.status(customer.status || 401).json({ error: customer.error })
    }

    const { data: orders, error: ordersErr } = await supabase
      .from("orders")
      .select(
        "id, razorpay_order_id, edition, payment_type, amount, name, phone, email, address, created_at, story_submitted, total_order_value, paid_amount, balance_due, pending_amount, order_status, production_status"
      )
      .eq("email", customer.email)
      .order("created_at", { ascending: false })

    if (ordersErr) {
      console.error("❌ Failed to fetch account orders:", ordersErr)
      return res.status(500).json({ error: "Failed to fetch orders" })
    }

    const normalizedOrders = (orders || []).map((order) => ({
      ...order,
      total_order_value: order.total_order_value ?? order.amount ?? 0,
      paid_amount: order.paid_amount ?? order.amount ?? 0,
      balance_due: order.balance_due ?? order.pending_amount ?? 0,
    }))

    return res.json({
      success: true,
      email: customer.email,
      orders: normalizedOrders,
    })
  } catch (err) {
    console.error("❌ /account/orders error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/account/logout", async (req, res) => {
  try {
    const authHeader = String(req.header("Authorization") || "")

    if (!authHeader.startsWith("Bearer ")) return res.json({ success: true })

    const sessionToken = authHeader.replace("Bearer ", "").trim()

    if (sessionToken) {
      await supabase
        .from("customer_sessions")
        .update({ revoked: true })
        .eq("session_token", sessionToken)
    }

    return res.json({ success: true })
  } catch (err) {
    console.error("❌ /account/logout error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   CUSTOMER PROFILE FROM ORDERS
========================= */
app.get("/account/profile", async (req, res) => {
  try {
    const customer = await getCustomerFromSession(req)

    if (customer.error) {
      return res.status(customer.status || 401).json({ error: customer.error })
    }

    const { data: latestOrder, error } = await supabase
      .from("orders")
      .select("name, phone, email, address")
      .eq("email", customer.email)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (error || !latestOrder) {
      return res.status(404).json({ error: "No profile found for this account" })
    }

    return res.json({
      success: true,
      profile: {
        name: latestOrder.name || "",
        phone: latestOrder.phone || "",
        email: latestOrder.email || customer.email,
        address: latestOrder.address || "",
        location: "India",
      },
    })
  } catch (err) {
    console.error("❌ /account/profile error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.post("/account/profile", async (req, res) => {
  try {
    const customer = await getCustomerFromSession(req)

    if (customer.error) {
      return res.status(customer.status || 401).json({ error: customer.error })
    }

    const name = String(req.body?.name || "").trim()
    const phone = String(req.body?.phone || "").trim()
    const address = String(req.body?.address || "").trim()

    if (!name) return res.status(400).json({ error: "Name is required" })
    if (!phone || phone.length < 8) return res.status(400).json({ error: "Valid phone number is required" })
    if (!address) return res.status(400).json({ error: "Address is required" })

    const { data, error } = await supabase
      .from("orders")
      .update({ name, phone, address })
      .eq("email", customer.email)
      .select("id, name, phone, email, address")

    if (error) {
      console.error("❌ Failed to update account profile:", error)
      return res.status(500).json({ error: "Failed to update profile" })
    }

    return res.json({
      success: true,
      updatedOrders: data?.length || 0,
      profile: { name, phone, email: customer.email, address, location: "India" },
    })
  } catch (err) {
    console.error("❌ /account/profile update error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

app.get("/my-orders", async (req, res) => {
  try {
    return res.status(410).json({
      error: "Legacy my-orders endpoint is no longer used. Please use /account/orders.",
    })
  } catch (err) {
    console.error("❌ /my-orders error:", safeErr(err))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   SEND PORTAL LINK
========================= */
app.post("/send-portal-link", rateLimit({ windowMs: 60 * 60 * 1000, maxRequests: 10, keyPrefix: "portal-link" }), async (req, res) => {
  try {
    const { email } = req.body
    const normalizedEmail = normalizeEmail(email)

    if (!normalizedEmail || !normalizedEmail.includes("@")) {
      return res.status(400).json({ error: "Valid email required" })
    }

    const { data: order, error } = await supabase
      .from("orders")
      .select("id, razorpay_order_id, edition, email, created_at")
      .eq("email", normalizedEmail)
      .order("created_at", { ascending: false })
      .limit(1)
      .single()

    if (error || !order) {
      console.error("❌ No order found for email:", normalizedEmail, error)
      return res.status(404).json({ error: "No order found for this email" })
    }

    const token = crypto.randomBytes(24).toString("hex")
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()

    const { error: upErr } = await supabase
      .from("orders")
      .update({ portal_token: token, portal_token_expires_at: expiresAt, portal_token_used: false })
      .eq("id", order.id)

    if (upErr) {
      console.error("❌ Failed to save token:", upErr)
      return res.status(500).json({ error: "Failed to create link" })
    }

    const portalUrl = `${PORTAL_BASE_URL}/story?token=${token}`

    const html = brandedEmailTemplate({
      title: "Your writing link",
      bodyHtml:
        emailParagraph("Here is your secure link to continue your SoulScript Legacy story.") +
        emailMuted("This link expires in 30 minutes."),
      ctaLabel: "Open Story Portal",
      ctaUrl: portalUrl,
    })

    const sent = await sendEmailSafe({ to: normalizedEmail, subject: "Your SoulScript Legacy writing link", html })

    if (sent.ok) return res.json({ success: true, portalUrl })

    const fallback = await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: "Portal link fallback - customer blocked",
      html: brandedEmailTemplate({
        title: "Portal link fallback",
        bodyHtml:
          emailParagraph("Resend could not send directly to this customer.") +
          emailDetails([
            { label: "Customer email", value: normalizedEmail },
            { label: "Portal URL", value: portalUrl },
          ]),
        ctaLabel: "Open Story Portal",
        ctaUrl: portalUrl,
      }),
    })

    if (fallback.ok) {
      return res.json({
        success: true,
        portalUrl,
        warning: "Resend blocked sending to customer. Sent fallback to admin email instead.",
        resend_error: sent.error,
      })
    }

    return res.status(500).json({ error: "Email sending failed (Resend).", portalUrl })
  } catch (e) {
    console.error("❌ /send-portal-link error:", safeErr(e))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   OPEN PORTAL USING TOKEN OR ORDER ID
========================= */
app.get("/portal-order", rateLimit({ windowMs: 60 * 1000, maxRequests: 30, keyPrefix: "portal-order" }), async (req, res) => {
  try {
    const token = String(req.query.token || "").trim()
    const orderId = String(req.query.order || "").trim()
    const redirect = String(req.query.redirect || "").trim() === "1"

    if (!token && !orderId) {
      return res.status(400).json({ error: "Token or order ID missing" })
    }

    let query = supabase.from("orders").select("*")

    if (token) query = query.eq("portal_token", token)
    else query = query.eq("razorpay_order_id", orderId)

    const { data: order, error } = await query.single()

    if (error || !order) {
      console.error("❌ Order not found:", error)
      return res.status(404).json({ error: "Invalid link or order not found" })
    }

    if (token) {
      if (order.portal_token_used) {
        return res.status(410).json({ error: "Link already used. Please request a new link." })
      }

      if (order.portal_token_expires_at) {
        const exp = new Date(order.portal_token_expires_at).getTime()
        if (Date.now() > exp) {
          return res.status(410).json({ error: "Link expired. Please request a new link." })
        }
      }

      const { error: usedErr } = await supabase
        .from("orders")
        .update({ portal_token_used: true })
        .eq("id", order.id)

      if (usedErr) console.error("⚠️ Failed to mark token used:", usedErr)
    }

    const [
      storyIntakeRes,
      voiceNotesRes,
      callBookingsRes,
      deliverablesRes,
      revisionsRes,
      addonsRes,
      reviewFilesRes,
    ] = await Promise.all([
      supabase.from("story_intakes").select("*").eq("order_id", order.id).order("updated_at", { ascending: false }),
      supabase.from("voice_notes").select("*").eq("order_id", order.id).order("created_at", { ascending: false }),
      supabase.from("call_bookings").select("*").eq("order_id", order.id).order("created_at", { ascending: false }),
      supabase.from("deliverables").select("*").eq("order_id", order.id).order("uploaded_at", { ascending: false }),
      supabase.from("revisions").select("*").eq("order_id", order.id).order("created_at", { ascending: false }),
      supabase.from("order_addons").select("*").eq("order_id", order.id).order("created_at", { ascending: false }),
      supabase.from("review_files").select("*").eq("order_id", order.id).order("created_at", { ascending: false }),
    ])

    if (redirect) {
      const target = `${PORTAL_BASE_URL}/story?order=${encodeURIComponent(order.razorpay_order_id)}`
      return res.redirect(302, target)
    }

    const activeStoryIntake =
      (storyIntakeRes.data || []).find(
        (item) => item.submitted !== true && !item.submitted_at
      ) ||
      (storyIntakeRes.data || [])[0] ||
      null

    const signedDeliverables = await withSignedDeliverables(deliverablesRes.data || [])
    const signedReviewFiles = await withSignedReviewFiles(reviewFilesRes.data || [])
    const latestReviewFile =
      signedReviewFiles.find((item) => item.id === order.latest_review_file_id) ||
      signedReviewFiles[0] ||
      null

    return res.json({
      success: true,
      order: {
        ...order,
        story_intake: activeStoryIntake,
        story_intakes: storyIntakeRes.data || [],
        voice_notes: voiceNotesRes.data || [],
        call_bookings: callBookingsRes.data || [],
        deliverables: signedDeliverables,
        revisions: revisionsRes.data || [],
        addons: addonsRes.data || [],
        review_files: signedReviewFiles,
        latest_review_file: latestReviewFile,
        limits: {
          included_voice_seconds: getIncludedVoiceSeconds(order.edition),
          review_timeline: getReviewTimeline(order.edition),
        },
      },
    })
  } catch (e) {
    console.error("❌ /portal-order error:", safeErr(e))
    return res.status(500).json({ error: "Server error" })
  }
})

/* =========================
   STORY PORTAL API
========================= */
app.post("/story/create-extra-writing", async (req, res) => {
    try {
        const { orderId, requestText } = req.body
        const order = await getOrderByIdOrRazorpay(orderId)
        if (!order) return res.status(404).json({ error: "Order not found" })

        const cleanText = normalizeText(requestText, 30000)
        if (!cleanText) {
            return res.status(400).json({ error: "Request text is required" })
        }

        const wordCount = cleanText.split(/\s+/).filter(Boolean).length
        if (wordCount < 1) {
            return res.status(400).json({ error: "Request text is empty" })
        }

        const amount = wordCount * EXTRA_WRITING_PRICE_PER_WORD

        const receipt = `ssl_extrawrite_${Date.now()}`
        const razorpayOrder = await razorpay.orders.create({
            amount: amount * 100,
            currency: "INR",
            receipt,
            notes: {
                flow: "extra_writing",
                orderId: order.id,
                razorpayOrderId: order.razorpay_order_id,
                wordCount: String(wordCount),
                amount: String(amount),
                customerEmail: order.email,
            },
        })

        const { data: request, error: insertErr } = await supabase
            .from("extra_writing_requests")
            .insert({
                order_id: order.id,
                request_text: cleanText,
                word_count: wordCount,
                amount,
                razorpay_order_id: razorpayOrder.id,
                payment_status: "pending",
                status: "pending",
            })
            .select("*")
            .single()

        if (insertErr) {
            console.error("Extra writing insert failed:", insertErr)
            return res.status(500).json({ error: "Could not create request" })
        }

        return res.json({
            success: true,
            keyId: RAZORPAY_KEY_ID,
            razorpayKeyId: RAZORPAY_KEY_ID,
            razorpayOrderId: razorpayOrder.id,
            amount: razorpayOrder.amount,
            currency: razorpayOrder.currency,
            amountRupees: amount,
            wordCount,
            extraWritingId: request.id,
        })
    } catch (err) {
        console.error("/story/create-extra-writing error:", safeErr(err))
        return res.status(500).json({ error: err?.message || "Could not start extra writing payment" })
    }
})

app.post("/story/confirm-extra-writing", async (req, res) => {
    try {
        const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body

        if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
            return res.status(400).json({ error: "Missing payment verification data" })
        }

        const expectedSignature = crypto
            .createHmac("sha256", RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex")

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ error: "Invalid payment signature" })
        }

        const { data: request, error: requestErr } = await supabase
            .from("extra_writing_requests")
            .select("*")
            .eq("razorpay_order_id", razorpay_order_id)
            .single()

        if (requestErr || !request) {
            return res.status(404).json({ error: "Extra writing request not found" })
        }

        if (request.payment_status === "paid") {
            return res.json({ success: true, alreadyPaid: true, request })
        }

        const now = new Date().toISOString()

        await supabase
            .from("extra_writing_requests")
            .update({
                payment_status: "paid",
                razorpay_payment_id,
                paid_at: now,
            })
            .eq("id", request.id)

        const { data: order } = await supabase
            .from("orders")
            .select("*")
            .eq("id", request.order_id)
            .single()

        await sendEmailSafe({
            to: REVIEW_NOTIFICATION_EMAIL,
            subject: `New paid extra writing request — ${order?.name || "Customer"} — ₹${request.amount}`,
            html: brandedEmailTemplate({
                title: "New extra writing request received",
                bodyHtml:
                    emailParagraph("A customer has paid for an extra writing request.") +
                    emailDetails([
                        { label: "Order", value: order?.razorpay_order_id || request.order_id },
                        { label: "Customer", value: order?.name || "" },
                        { label: "Email", value: order?.email || "" },
                        { label: "Edition", value: order?.edition || "" },
                        { label: "Word count", value: String(request.word_count) },
                        { label: "Amount paid", value: `₹${request.amount}` },
                        { label: "Request", value: nl2br(request.request_text), html: true },
                    ]),
            }),
        })

        return res.json({
            success: true,
            request: { ...request, payment_status: "paid", paid_at: now, razorpay_payment_id },
        })
    } catch (err) {
        if (typeof Sentry !== "undefined" && process.env.SENTRY_DSN) {
            Sentry.captureException(err, { tags: { endpoint: "confirm-extra-writing" } })
        }
        console.error("/story/confirm-extra-writing error:", safeErr(err))
        return res.status(500).json({ error: "Extra writing payment confirmation failed" })
    }
})

app.post("/story/create-addon-order", async (req, res) => {
  try {
    const { orderId, addonType, quantity = 1, customAmount, description, metadata } = req.body

    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    if (addonType === "extra_hardcover_copy" && order.edition === "Confession Edition") {
      return res.status(400).json({ error: "Hardcover extra copy is not available for Confession Edition" })
    }

    const amount = getAddonAmount({ addonType, quantity, customAmount })
    const qty = Math.max(1, Number(quantity || 1))
    const receipt = `ssl_addon_${Date.now()}`

    const razorpayOrder = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt,
      notes: {
        flow: "story_addon",
        orderId: order.id,
        razorpayOrderId: order.razorpay_order_id,
        addonType,
        quantity: String(qty),
        amount: String(amount),
        customerEmail: order.email,
      },
    })

    const { data: addon, error: addonErr } = await supabase
      .from("order_addons")
      .insert({
        order_id: order.id,
        addon_type: addonType,
        title: description || addonType,
        description: description || null,
        quantity: qty,
        unit_price: amount / qty,
        amount,
        status: "payment_created",
        payment_status: "payment_created",
        razorpay_order_id: razorpayOrder.id,
        metadata: metadata || {},
      })
      .select("*")
      .single()

    if (addonErr) {
      console.error("❌ Add-on insert failed:", addonErr)
      return res.status(500).json({ error: "Could not create add-on record" })
    }

    return res.json({
      success: true,
      keyId: getRazorpayPublicKey(),
      razorpayKeyId: getRazorpayPublicKey(),
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      amountRupees: amount,
      addon,
    })
  } catch (err) {
    console.error("❌ /story/create-addon-order error:", safeErr(err))
    return res.status(400).json({ error: err?.message || "Could not create add-on payment" })
  }
})

app.post("/story/confirm-addon-payment", async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification data" })
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex")

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" })
    }

    const { data: addon, error: addonErr } = await supabase
      .from("order_addons")
      .update({
        status: "paid",
        payment_status: "paid",
        razorpay_payment_id,
        razorpay_signature,
        paid_at: new Date().toISOString(),
      })
      .eq("razorpay_order_id", razorpay_order_id)
      .select("*")
      .single()

    if (addonErr || !addon) {
      console.error("❌ Add-on payment update failed:", addonErr)
      return res.status(404).json({ error: "Add-on payment record not found" })
    }

    if (addon.addon_type === "custom_cover") {
      await supabase.from("orders").update({ custom_cover_paid: true }).eq("id", addon.order_id)
    }

    if (addon.addon_type === "voice_note_hour") {
      await supabase
        .from("orders")
        .update({ voice_note_addon_paid: true })
        .eq("id", addon.order_id)
    }

    if (addon.addon_type === "balance_payment") {
      await supabase
        .from("orders")
        .update({ balance_due: 0, pending_amount: 0, balance_paid_at: new Date().toISOString() })
        .eq("id", addon.order_id)
    }

    if (["extra_softcover_copy", "extra_hardcover_copy"].includes(addon.addon_type)) {
      await supabase.from("print_addons").insert({
        order_id: addon.order_id,
        addon_id: addon.id,
        addon_type: addon.addon_type,
        quantity: Number(addon.quantity || 1),
        amount: Number(addon.amount || 0),
        payment_status: "paid",
      })
    }

    if (addon.addon_type === "extra_polaroids_pack") {
      const metadata = safeJsonObject(addon.metadata)
      const photoPaths = Array.isArray(metadata.photo_paths) ? metadata.photo_paths : []

      if (photoPaths.length > 0) {
        await supabase.from("polaroid_photos").insert(
          photoPaths.map((filePath) => ({
            order_id: addon.order_id,
            addon_id: addon.id,
            file_path: String(filePath),
          }))
        )
      }
    }

    await refreshOrderTotals(addon.order_id)

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", addon.order_id)
      .single()

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `Add-on paid - ${addon.addon_type}`,
      html: brandedEmailTemplate({
        title: "Add-on payment received",
        bodyHtml:
          emailParagraph("A customer has completed an add-on payment.") +
          emailDetails([
            { label: "Order", value: order?.razorpay_order_id || addon.order_id },
            { label: "Customer", value: order?.name || "" },
            { label: "Email", value: order?.email || "" },
            { label: "Add-on", value: addon.addon_type },
            { label: "Amount", value: `₹${addon.amount}` },
          ]),
      }),
    })

    return res.json({ success: true, addon })
  } catch (err) {
    if (typeof Sentry !== "undefined" && process.env.SENTRY_DSN) {
        Sentry.captureException(err, { tags: { endpoint: "confirm-addon-payment" } })
    }
    console.error("❌ /story/confirm-addon-payment error:", safeErr(err))
    return res.status(500).json({ error: "Add-on payment confirmation failed" })
  }
})

app.post("/story/save-intake-draft", async (req, res) => {
  try {
    const {
      orderId,
      coverTitle,
      authorName,
      coverNotes,
      noteToWriter,
      tone,
      coverType,
      coverPhotoPath,
      referenceImagePaths = [],
      essenceInputChoice,
    } = req.body

    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    if (order.story_submitted) {
      return res.json({ success: true, locked: true })
    }

    const story_intake = await upsertStoryIntakeDraft(order, {
      coverTitle,
      authorName,
      coverNotes,
      noteToWriter,
      tone,
      coverType,
      coverPhotoPath,
      referenceImagePaths,
      essenceInputChoice,
    })

    return res.json({
      success: true,
      story_intake,
    })
  } catch (err) {
    console.error("❌ /story/save-intake-draft error:", safeErr(err))
    return res.status(500).json({
      error: err?.message || "Intake draft save failed",
    })
  }
})

app.post("/story/save-cover-photo", async (req, res) => {
  try {
    const { orderId, photoPath } = req.body

    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    if (order.story_submitted) {
      return res.json({ success: true, locked: true })
    }

    if (!photoPath) {
      return res.status(400).json({ error: "photoPath required" })
    }

    const story_intake = await upsertStoryIntakeDraft(order, {
      coverPhotoPath: photoPath,
    })

    return res.json({ success: true, story_intake })
  } catch (err) {
    console.error("❌ /story/save-cover-photo error:", safeErr(err))
    return res.status(500).json({ error: "Cover photo save failed" })
  }
})

app.post("/story/save-draft", async (req, res) => {
  try {
    const { orderId, story } = req.body
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })
    if (order.story_submitted) return res.json({ success: true, locked: true })

    const cleanStory = normalizeText(story, 50000)

    const { error } = await supabase
      .from("orders")
      .update({ story: cleanStory })
      .eq("id", order.id)

    if (error) return res.status(500).json({ error: "Failed to save draft" })

    return res.json({ success: true })
  } catch (err) {
    console.error("❌ /story/save-draft error:", safeErr(err))
    return res.status(500).json({ error: "Draft save failed" })
  }
})

app.post("/story/register-voice-note", async (req, res) => {
  try {
    const { orderId, filePath, fileName, durationSeconds = 0, paidByAddon = false } = req.body
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })
    if (!filePath) return res.status(400).json({ error: "filePath required" })

    const duration = Number(durationSeconds || 0)

    const { data: existingVoiceNotes } = await supabase
      .from("voice_notes")
      .select("duration_seconds")
      .eq("order_id", order.id)

    const usedSeconds = (existingVoiceNotes || []).reduce((sum, row) => sum + Number(row.duration_seconds || 0), 0)
    const includedSeconds = getIncludedVoiceSeconds(order.edition)

    const { data: paidVoiceAddons } = await supabase
      .from("order_addons")
      .select("quantity, status, payment_status")
      .eq("order_id", order.id)
      .eq("addon_type", "voice_note_hour")
      .or("status.eq.paid,payment_status.eq.paid")

    const paidSeconds = (paidVoiceAddons || []).reduce((sum, item) => sum + Number(item.quantity || 1) * 3600, 0)
    const allowedSeconds = includedSeconds + paidSeconds

    if (duration > 0 && usedSeconds + duration > allowedSeconds && !paidByAddon) {
      return res.status(402).json({
        error: "Voice note limit exceeded. Please purchase extra voice note time.",
        usedSeconds,
        allowedSeconds,
      })
    }

    const { data, error } = await supabase
      .from("voice_notes")
      .insert({
        order_id: order.id,
        file_path: filePath,
        file_name: fileName || null,
        duration_seconds: Number.isFinite(duration) ? duration : null,
        paid_by_addon: !!paidByAddon,
      })
      .select("*")
      .single()

    if (error) {
      console.error("❌ Voice note register failed:", error)
      return res.status(500).json({ error: "Could not register voice note" })
    }

    return res.json({ success: true, voice_note: data, usedSeconds: usedSeconds + duration, allowedSeconds })
  } catch (err) {
    console.error("❌ /story/register-voice-note error:", safeErr(err))
    return res.status(500).json({ error: "Voice note registration failed" })
  }
})

app.post("/story/delete-voice-note", async (req, res) => {
  try {
    const { orderId, voiceNoteId } = req.body

    if (!orderId || !voiceNoteId) {
      return res.status(400).json({ error: "orderId and voiceNoteId are required" })
    }

    const order = await getOrderByIdOrRazorpay(orderId)

    if (!order) {
      return res.status(404).json({ error: "Order not found" })
    }

    if (order.story_submitted) {
      return res.status(403).json({
        error: "Story has already been submitted. Voice notes cannot be deleted now.",
      })
    }

    const { data: voiceNote, error: voiceNoteErr } = await supabase
      .from("voice_notes")
      .select("*")
      .eq("id", voiceNoteId)
      .eq("order_id", order.id)
      .single()

    if (voiceNoteErr || !voiceNote) {
      console.error("❌ Voice note not found for delete:", voiceNoteErr)
      return res.status(404).json({ error: "Voice note not found" })
    }

    if (voiceNote.file_path) {
      const { error: storageErr } = await supabase.storage
        .from(STORAGE_BUCKETS.voiceNotes)
        .remove([voiceNote.file_path])

      if (storageErr) {
        console.error("⚠️ Voice note storage delete failed:", storageErr)
      }
    }

    const { error: deleteErr } = await supabase
      .from("voice_notes")
      .delete()
      .eq("id", voiceNote.id)
      .eq("order_id", order.id)

    if (deleteErr) {
      console.error("❌ Voice note DB delete failed:", deleteErr)
      return res.status(500).json({ error: "Could not delete voice note" })
    }

    return res.json({
      success: true,
      deletedVoiceNoteId: voiceNote.id,
      deletedFilePath: voiceNote.file_path || null,
    })
  } catch (err) {
    console.error("❌ /story/delete-voice-note error:", safeErr(err))
    return res.status(500).json({ error: "Voice note delete failed" })
  }
})

app.post("/story/submit-intake", async (req, res) => {
  try {
    const {
      orderId,
      textStory,
      wordCount,
      tone,
      noteToWriter,
      coverType,
      coverNotes,
      coverTitle,
      authorName,
      coverPhotoPath,
      referenceImagePaths = [],
      essenceInputChoice,
      callBooking,
    } = req.body

    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })
    if (order.story_submitted) return res.json({ success: true, story_submitted: true })

    const cleanStory = normalizeText(textStory || order.story, 80000)
    if (!cleanStory) return res.status(400).json({ error: "Story text is required" })

    const cleanCoverNotes = normalizeText(coverNotes, 3500)
    const cleanNoteToWriter = normalizeText(noteToWriter, 3500)

    const intakeDraft = await upsertStoryIntakeDraft(order, {
      textStory: cleanStory,
      wordCount: Number(wordCount || cleanStory.split(/\s+/).filter(Boolean).length),
      tone,
      noteToWriter: cleanNoteToWriter,
      coverType,
      coverNotes: cleanCoverNotes,
      coverTitle,
      authorName,
      coverPhotoPath,
      referenceImagePaths,
      essenceInputChoice,
    })

    const { data: intake, error: intakeErr } = await supabase
      .from("story_intakes")
      .update({
        submitted: true,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", intakeDraft.id)
      .select("*")
      .single()

    if (intakeErr) {
      console.error("❌ Story intake submit update failed:", intakeErr)
      return res.status(500).json({ error: "Failed to submit story intake" })
    }

    if (order.edition === "Essence Edition" && essenceInputChoice === "call" && callBooking) {
      await supabase.from("call_bookings").insert({
        order_id: order.id,
        preferred_date: callBooking.preferredDate || null,
        preferred_time: callBooking.preferredTime || null,
        listener_pref: callBooking.listenerPref || null,
        call_type: callBooking.callType || "Google Meet / Voice Call",
        duration_hours: 1,
        amount: 0,
        paid: true,
        status: "requested",
        customer_note: callBooking.customerNote || null,
      })
    }

    const { error: orderUpdateErr } = await supabase
      .from("orders")
      .update({
        story: cleanStory,
        story_submitted: true,
        story_submitted_at: new Date().toISOString(),
        production_status: "story_submitted",
        order_status: "story_submitted",
      })
      .eq("id", order.id)

    if (orderUpdateErr) {
      console.error("❌ Order story submit update failed:", orderUpdateErr)
      return res.status(500).json({ error: "Story saved but order status failed" })
    }

    const timeline = getReviewTimeline(order.edition)

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `Story submitted - ${order.edition}`,
      html: brandedEmailTemplate({
        title: "Story submitted",
        bodyHtml:
          emailParagraph("A customer has submitted their story intake.") +
          emailDetails([
            { label: "Edition", value: order.edition },
            { label: "Order", value: order.razorpay_order_id },
            { label: "Name", value: order.name },
            { label: "Email", value: order.email },
            { label: "Phone", value: order.phone },
            { label: "Cover type", value: coverType || "" },
            { label: "Title", value: coverTitle || "" },
            { label: "Author", value: authorName || "" },
            { label: "Note to writer", value: nl2br(cleanNoteToWriter), html: true },
          ]) +
          emailDivider() +
          emailParagraph("<strong>Story</strong>") +
          emailMuted(nl2br(cleanStory)),
      }),
    })

    await sendEmailSafe({
      to: order.email,
      subject: "Your story has been submitted",
      html: brandedEmailTemplate({
        title: "Your story is with us",
        bodyHtml:
          emailParagraph(`Dear ${escapeHtml(order.name)},`) +
          emailParagraph("Your story submission has been received successfully.") +
          emailParagraph(`Your review files will be shared within <strong>${escapeHtml(timeline)}</strong>.`) +
          emailParagraph("Because this is a custom novel written specifically around your life and details, the writing and review process takes careful time."),
      }),
    })

    return res.json({ success: true, story_submitted: true, intake, timeline })
  } catch (err) {
    console.error("❌ /story/submit-intake error:", safeErr(err))
    return res.status(500).json({ error: "Story submission failed" })
  }
})

/* Legacy submit story kept */
app.post("/submit-story", async (req, res) => {
  const { orderId, story } = req.body

  if (!orderId || !story || !story.trim()) {
    return res.status(400).json({ error: "Order ID or story missing" })
  }

  try {
    const { data: order, error } = await supabase
      .from("orders")
      .select("*")
      .eq("razorpay_order_id", orderId)
      .single()

    if (error || !order) {
      console.error("❌ Order not found:", error)
      return res.status(404).json({ error: "Order not found" })
    }

    if (order.story_submitted) {
      return res.json({ success: true, story_submitted: true })
    }

    const cleanStory = normalizeText(story, 80000)

    const { error: updateError } = await supabase
      .from("orders")
      .update({
        story: cleanStory,
        story_submitted: true,
        story_submitted_at: new Date().toISOString(),
        production_status: "story_submitted",
        order_status: "story_submitted",
      })
      .eq("id", order.id)

    if (updateError) {
      console.error("❌ Story update failed:", updateError)
      return res.status(500).json({ error: "Failed to save story" })
    }

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `Story submitted - ${order.edition}`,
      html: brandedEmailTemplate({
        title: "Story submitted",
        bodyHtml:
          emailParagraph("A story was submitted through the legacy endpoint.") +
          emailDetails([
            { label: "Edition", value: order.edition },
            { label: "Name", value: order.name },
            { label: "Email", value: order.email },
            { label: "Phone", value: order.phone },
          ]) +
          emailDivider() +
          emailParagraph("<strong>Story</strong>") +
          emailMuted(nl2br(cleanStory)),
      }),
    })

    return res.json({ success: true, story_submitted: true })
  } catch (err) {
    console.error("❌ Submit story error:", safeErr(err))
    return res.status(500).json({ error: "Submit story error" })
  }
})

app.post("/story/request-revision", async (req, res) => {
  try {
    const { orderId, type, description } = req.body
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    const revisionType = ["cover", "manuscript", "both"].includes(type) ? type : "both"
    const cleanDescription = normalizeText(description, 6000)
    if (!cleanDescription) return res.status(400).json({ error: "Revision description required" })

    const { data, error } = await supabase
      .from("revisions")
      .insert({
        order_id: order.id,
        type: revisionType,
        description: cleanDescription,
        is_free: null,
        charge: null,
        paid: false,
        status: "requested",
      })
      .select("*")
      .single()

    if (error) {
      console.error("❌ Revision insert failed:", error)
      return res.status(500).json({ error: "Could not request changes" })
    }

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `Revision requested - ${order.edition}`,
      html: brandedEmailTemplate({
        title: "Revision requested",
        bodyHtml:
          emailParagraph("A customer has requested changes.") +
          emailDetails([
            { label: "Order", value: order.razorpay_order_id },
            { label: "Customer", value: order.name },
            { label: "Type", value: revisionType },
            { label: "Description", value: nl2br(cleanDescription), html: true },
          ]),
      }),
    })

    await sendEmailSafe({
      to: order.email,
      subject: "We received your change request",
      html: brandedEmailTemplate({
        title: "Change request received",
        bodyHtml:
          emailParagraph(`Dear ${escapeHtml(order.name)},`) +
          emailParagraph("We have received your requested changes for your novel.") +
          emailParagraph("If the correction falls within the original brief or is a mistake from our side, it will be corrected without additional charge.") +
          emailParagraph("If it introduces new requirements outside the original brief, our team will share the applicable charges before proceeding.") +
          emailParagraph("You will receive an update within approximately 2 working days."),
      }),
    })

    return res.json({ success: true, revision: data })
  } catch (err) {
    console.error("❌ /story/request-revision error:", safeErr(err))
    return res.status(500).json({ error: "Could not request revision" })
  }
})

app.post("/story/proceed-print", async (req, res) => {
  try {
    const { orderId } = req.body
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    const balanceDue = Number(order.balance_due || 0)
    if (Number.isFinite(balanceDue) && balanceDue > 0) {
      return res.status(402).json({
        error: "Balance payment required before proceeding to print.",
        balanceDue,
        requiresBalancePayment: true,
      })
    }

    const now = new Date().toISOString()

    const { data, error } = await supabase
      .from("deliverables")
      .update({ print_requested_at: now, status: "print_requested" })
      .eq("order_id", order.id)
      .select("*")

    if (error) {
      console.error("❌ Print request update failed:", error)
      return res.status(500).json({ error: "Could not send to print" })
    }

    await supabase
      .from("review_files")
      .update({ approved_for_print_at: now, status: "approved_for_print" })
      .eq("order_id", order.id)

    await supabase
      .from("orders")
      .update({
        production_status: "print_requested",
        order_status: "print_requested",
        print_requested_at: now,
        print_approved_at: now,
        sent_to_print_at: now,
      })
      .eq("id", order.id)

    await sendEmailSafe({
      to: order.email,
      subject: "Your book has been sent for printing",
      html: brandedEmailTemplate({
        title: "Sent for printing",
        bodyHtml:
          emailParagraph(`Dear ${escapeHtml(order.name)},`) +
          emailParagraph("Your manuscript and cover have been approved and your book has now been sent for printing.") +
          emailParagraph("Since this is a customized novel written specifically around your life, the final production and quality checks take careful time.") +
          emailParagraph("You can expect delivery within <strong>16 to 21 working days</strong>."),
      }),
    })

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `Print requested - ${order.edition}`,
      html: brandedEmailTemplate({
        title: "Print requested",
        bodyHtml:
          emailParagraph("A customer has approved review files for printing.") +
          emailDetails([
            { label: "Order", value: order.razorpay_order_id },
            { label: "Customer", value: order.name },
            { label: "Edition", value: order.edition },
          ]),
      }),
    })

    return res.json({ success: true, deliverables: data || [] })
  } catch (err) {
    console.error("❌ /story/proceed-print error:", safeErr(err))
    return res.status(500).json({ error: "Could not proceed with print" })
  }
})


app.post("/story/create-balance-payment", async (req, res) => {
  try {
    const { orderId } = req.body
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    const balanceDue = Number(order.balance_due || 0)
    if (!Number.isFinite(balanceDue) || balanceDue <= 0) {
      return res.status(400).json({ error: "No balance due on this order." })
    }

    const receipt = `ssl_balance_${Date.now()}`

    const razorpayOrder = await razorpay.orders.create({
      amount: balanceDue * 100,
      currency: "INR",
      receipt,
      notes: {
        flow: "balance_payment",
        orderId: order.id,
        razorpayOrderId: order.razorpay_order_id,
        balanceDue: String(balanceDue),
        customerEmail: order.email,
      },
    })

    await supabase
      .from("orders")
      .update({ balance_razorpay_order_id: razorpayOrder.id })
      .eq("id", order.id)

    return res.json({
      success: true,
      keyId: getRazorpayPublicKey(),
      razorpayKeyId: getRazorpayPublicKey(),
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      amountRupees: balanceDue,
    })
  } catch (err) {
    console.error("❌ /story/create-balance-payment error:", safeErr(err))
    return res.status(500).json({ error: err?.message || "Could not create balance payment" })
  }
})

app.post("/story/confirm-balance-payment", async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification data" })
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex")

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" })
    }

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*")
      .eq("balance_razorpay_order_id", razorpay_order_id)
      .single()

    if (orderErr || !order) {
      return res.status(404).json({ error: "No order found for this balance payment." })
    }

    const now = new Date().toISOString()
    const newPaidAmount = Number(order.paid_amount || 0) + Number(order.balance_due || 0)

    await supabase
      .from("orders")
      .update({
        paid_amount: newPaidAmount,
        balance_due: 0,
        pending_amount: 0,
        balance_razorpay_payment_id: razorpay_payment_id,
        balance_paid_at: now,
      })
      .eq("id", order.id)

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `Balance payment received — ${order.edition}`,
      html: brandedEmailTemplate({
        title: "Balance payment received",
        bodyHtml:
          emailParagraph("A customer has paid their pending balance.") +
          emailDetails([
            { label: "Order", value: order.razorpay_order_id || order.id },
            { label: "Customer", value: order.name || "" },
            { label: "Email", value: order.email || "" },
            { label: "Balance paid", value: `₹${order.balance_due}` },
            { label: "Razorpay payment ID", value: razorpay_payment_id },
          ]),
      }),
    })

    await sendEmailSafe({
      to: order.email,
      subject: "Your balance payment is received",
      html: brandedEmailTemplate({
        title: "Balance payment received",
        bodyHtml:
          emailParagraph(`Dear ${escapeHtml(order.name || "")},`) +
          emailParagraph("We've received your balance payment. You can now proceed your book to print from your story portal."),
        ctaLabel: "Open Story Portal",
        ctaUrl: `${PORTAL_BASE_URL}/story?order=${encodeURIComponent(order.razorpay_order_id || "")}`,
      }),
    })

    return res.json({ success: true, balancePaid: true })
  } catch (err) {
    if (typeof Sentry !== "undefined" && process.env.SENTRY_DSN) {
        Sentry.captureException(err, { tags: { endpoint: "confirm-balance-payment" } })
    }
    console.error("❌ /story/confirm-balance-payment error:", safeErr(err))
    return res.status(500).json({ error: "Balance payment confirmation failed" })
  }
})

const ALLOWED_CART_ADDON_TYPES = new Set([
  "white_labeling",
  "extra_polaroids_pack",
  "extra_softcover_copy",
  "extra_hardcover_copy",
])

app.post("/story/create-cart-payment", async (req, res) => {
  try {
    const { orderId, items } = req.body

    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty." })
    }

    const validatedItems = []
    let totalAmount = 0

    for (const item of items) {
      const addonType = String(item?.addonType || "").trim()
      const quantity = Math.max(1, Number(item?.quantity || 1))

      if (!ALLOWED_CART_ADDON_TYPES.has(addonType)) {
        return res.status(400).json({ error: `Invalid item type: ${addonType}` })
      }

      if (addonType === "white_labeling") {
        const lockedStatuses = ["print_requested", "sent_to_print", "delivered", "completed", "in_transit"]
        if (lockedStatuses.includes(String(order.production_status || "").toLowerCase())) {
          return res.status(400).json({ error: "White labeling cannot be added after the book has been sent for printing." })
        }
        if (quantity > 1) {
          return res.status(400).json({ error: "White labeling can only be purchased once." })
        }
      }

      if (addonType === "extra_hardcover_copy" && order.edition === "Confession Edition") {
        return res.status(400).json({ error: "Hardcover extra copy is not available for Confession Edition." })
      }

      const unitPrice = ADDON_PRICES[addonType]
      if (!unitPrice) {
        return res.status(400).json({ error: `Price not configured for: ${addonType}` })
      }

      const itemTotal = addonType === "white_labeling" ? unitPrice : unitPrice * quantity
      totalAmount += itemTotal

      validatedItems.push({
        addonType,
        quantity,
        unitPrice,
        amount: itemTotal,
      })
    }

    if (totalAmount <= 0) {
      return res.status(400).json({ error: "Cart total must be greater than zero." })
    }

    const receipt = `ssl_cart_${Date.now()}`

    const razorpayOrder = await razorpay.orders.create({
      amount: totalAmount * 100,
      currency: "INR",
      receipt,
      notes: {
        flow: "story_cart",
        orderId: order.id,
        razorpayOrderId: order.razorpay_order_id,
        totalAmount: String(totalAmount),
        itemCount: String(validatedItems.length),
        customerEmail: order.email,
      },
    })

    const { data: cartPayment, error: cartErr } = await supabase
      .from("cart_payments")
      .insert({
        order_id: order.id,
        razorpay_order_id: razorpayOrder.id,
        total_amount: totalAmount,
        items: validatedItems,
        payment_status: "pending",
      })
      .select("*")
      .single()

    if (cartErr) {
      console.error("❌ Cart payment insert failed:", cartErr)
      return res.status(500).json({ error: "Could not create cart payment record." })
    }

    return res.json({
      success: true,
      keyId: getRazorpayPublicKey(),
      razorpayKeyId: getRazorpayPublicKey(),
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      amountRupees: totalAmount,
      cartPaymentId: cartPayment.id,
      validatedItems,
    })
  } catch (err) {
    console.error("❌ /story/create-cart-payment error:", safeErr(err))
    return res.status(400).json({ error: err?.message || "Could not create cart payment" })
  }
})

app.post("/story/confirm-cart-payment", async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification data" })
    }

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex")

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment signature" })
    }

    const { data: cartPayment, error: cartErr } = await supabase
      .from("cart_payments")
      .select("*")
      .eq("razorpay_order_id", razorpay_order_id)
      .single()

    if (cartErr || !cartPayment) {
      return res.status(404).json({ error: "Cart payment record not found." })
    }

    if (cartPayment.payment_status === "paid") {
      return res.json({ success: true, alreadyPaid: true, cart_payment: cartPayment })
    }

    const now = new Date().toISOString()

    await supabase
      .from("cart_payments")
      .update({
        payment_status: "paid",
        razorpay_payment_id,
        paid_at: now,
      })
      .eq("id", cartPayment.id)

    const items = Array.isArray(cartPayment.items) ? cartPayment.items : []
    const polaroidUploadSlots = []

    for (const item of items) {
      const addonType = item.addonType
      const quantity = Number(item.quantity || 1)
      const unitPrice = Number(item.unitPrice || 0)
      const amount = Number(item.amount || 0)

      const { data: addon, error: addonErr } = await supabase
        .from("order_addons")
        .insert({
          order_id: cartPayment.order_id,
          addon_type: addonType,
          title: addonType,
          quantity,
          unit_price: unitPrice,
          amount,
          status: "paid",
          payment_status: "paid",
          razorpay_order_id,
          razorpay_payment_id,
          paid_at: now,
          cart_payment_id: cartPayment.id,
          metadata: { source: "cart_payment" },
        })
        .select("*")
        .single()

      if (addonErr) {
        console.error("⚠️ Cart addon insert failed:", { addonType, error: addonErr })
        continue
      }

      if (addonType === "white_labeling") {
        await supabase
          .from("orders")
          .update({ white_labeling: true })
          .eq("id", cartPayment.order_id)
      }

      if (addonType === "extra_softcover_copy" || addonType === "extra_hardcover_copy") {
        await supabase.from("print_addons").insert({
          order_id: cartPayment.order_id,
          addon_id: addon.id,
          addon_type: addonType,
          quantity,
          amount,
          payment_status: "paid",
        })
      }

      if (addonType === "extra_polaroids_pack") {
        for (let pack = 0; pack < quantity; pack++) {
          polaroidUploadSlots.push({
            cart_payment_id: cartPayment.id,
            addon_id: addon.id,
            pack_index: pack,
          })
        }
      }
    }

    await supabase
      .from("orders")
      .update({
        cart_payments_total: Number(cartPayment.total_amount || 0),
        last_cart_payment_at: now,
      })
      .eq("id", cartPayment.order_id)

    await refreshOrderTotals(cartPayment.order_id)

    const { data: order } = await supabase
      .from("orders")
      .select("*")
      .eq("id", cartPayment.order_id)
      .single()

    await sendEmailSafe({
      to: ADMIN_EMAIL,
      subject: `Cart payment received — ₹${cartPayment.total_amount}`,
      html: brandedEmailTemplate({
        title: "Cart payment received",
        bodyHtml:
          emailParagraph("A customer has completed a cart payment.") +
          emailDetails([
            { label: "Order", value: order?.razorpay_order_id || cartPayment.order_id },
            { label: "Customer", value: order?.name || "" },
            { label: "Email", value: order?.email || "" },
            { label: "Total amount", value: `₹${cartPayment.total_amount}` },
            { label: "Items", value: items.map((i) => `${i.addonType} × ${i.quantity}`).join(", "), html: false },
          ]),
      }),
    })

    return res.json({
      success: true,
      cart_payment: { ...cartPayment, payment_status: "paid", paid_at: now, razorpay_payment_id },
      polaroidUploadSlots,
    })
  } catch (err) {
    if (typeof Sentry !== "undefined" && process.env.SENTRY_DSN) {
        Sentry.captureException(err, { tags: { endpoint: "confirm-cart-payment" } })
    }
    console.error("❌ /story/confirm-cart-payment error:", safeErr(err))
    return res.status(500).json({ error: "Cart payment confirmation failed" })
  }
})

app.post(
  "/story/upload-polaroid-photo",
  upload.single("photo"),
  async (req, res) => {
    try {
      const { orderId, cartPaymentId, packIndex } = req.body
      const file = req.file

      if (!file) {
        return res.status(400).json({ error: "Photo file required." })
      }

      if (!CHAT_IMAGE_ALLOWED_MIME.has(file.mimetype)) {
        return res.status(400).json({ error: "Only JPG, PNG, or WEBP photos are allowed." })
      }

      const order = await getOrderByIdOrRazorpay(orderId)
      if (!order) return res.status(404).json({ error: "Order not found" })

      const packIdx = Number(packIndex || 0)

      const timestamp = Date.now()
      const extension = fileExtensionFor(file, "jpg")
      const name = safeFileName(file.originalname || `polaroid.${extension}`)
      const path = `${order.id}/cart-${cartPaymentId || "unknown"}/pack-${packIdx}/${timestamp}-${name}`

      const { error: uploadErr } = await supabase.storage
        .from(STORAGE_BUCKETS.polaroids)
        .upload(path, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        })

      if (uploadErr) {
        console.error("❌ Polaroid upload failed:", uploadErr)
        return res.status(500).json({ error: "Could not upload photo." })
      }

      const { data: photo, error: photoErr } = await supabase
        .from("polaroid_photos")
        .insert({
          order_id: order.id,
          cart_payment_id: cartPaymentId || null,
          pack_index: packIdx,
          file_path: path,
        })
        .select("*")
        .single()

      if (photoErr) {
        console.error("❌ Polaroid record insert failed:", photoErr)
        return res.status(500).json({ error: "Could not save photo record." })
      }

      const signedUrl = await createSignedUrl(STORAGE_BUCKETS.polaroids, path)

      return res.json({
        success: true,
        photo: { ...photo, signed_url: signedUrl },
      })
    } catch (err) {
      console.error("❌ /story/upload-polaroid-photo error:", safeErr(err))
      return res.status(500).json({ error: "Polaroid upload failed" })
    }
  }
)

app.get("/portal/revision-chat-messages", rateLimit({ windowMs: 60 * 1000, maxRequests: 60, keyPrefix: "chat-poll" }), async (req, res) => {
  try {
    const { orderId } = req.query
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    const { data: messages, error } = await supabase
      .from("revision_chat_messages")
      .select("*")
      .eq("order_id", order.id)
      .order("created_at", { ascending: true })

    if (error) {
      console.error("❌ Chat messages fetch failed:", error)
      return res.status(500).json({ error: "Could not load chat messages." })
    }

    await supabase
      .from("revision_chat_messages")
      .update({ is_read_by_customer: true })
      .eq("order_id", order.id)
      .eq("sender_type", "admin")
      .eq("is_read_by_customer", false)

    const signedMessages = await withSignedChatMessages(messages || [])

    return res.json({ success: true, messages: signedMessages })
  } catch (err) {
    console.error("❌ /portal/revision-chat-messages error:", safeErr(err))
    return res.status(500).json({ error: "Could not load chat messages" })
  }
})

app.post(
  "/portal/revision-chat-upload-image",
  chatImageUpload.array("images", CHAT_IMAGE_MAX_PER_MESSAGE),
  async (req, res) => {
    try {
      const { orderId } = req.body
      const order = await getOrderByIdOrRazorpay(orderId)
      if (!order) return res.status(404).json({ error: "Order not found" })

      const files = Array.isArray(req.files) ? req.files : []

      if (files.length === 0) {
        return res.status(400).json({ error: "No images uploaded." })
      }

      if (files.length > CHAT_IMAGE_MAX_PER_MESSAGE) {
        return res.status(400).json({ error: `Max ${CHAT_IMAGE_MAX_PER_MESSAGE} images per message.` })
      }

      const uploaded = []
      for (const file of files) {
        const path = await uploadRevisionChatImage(order.id, file)
        const signedUrl = await createSignedUrl(STORAGE_BUCKETS.revisionChatMedia, path)
        uploaded.push({
          path,
          file_name: file.originalname || basenameFromPath(path),
          signed_url: signedUrl,
        })
      }

      return res.json({ success: true, uploaded })
    } catch (err) {
      console.error("❌ /portal/revision-chat-upload-image error:", safeErr(err))
      return res.status(500).json({ error: err?.message || "Image upload failed" })
    }
  }
)

app.post("/portal/revision-chat-message", async (req, res) => {
  try {
    const { orderId, message, attachments } = req.body
    const order = await getOrderByIdOrRazorpay(orderId)
    if (!order) return res.status(404).json({ error: "Order not found" })

    const cleanMessage = normalizeText(message, 4000)
    const cleanAttachments = Array.isArray(attachments)
      ? attachments
          .filter((att) => att && (typeof att === "string" || att.path))
          .slice(0, CHAT_IMAGE_MAX_PER_MESSAGE)
          .map((att) => {
            if (typeof att === "string") return { path: att, file_name: basenameFromPath(att) }
            return {
              path: String(att.path),
              file_name: String(att.file_name || basenameFromPath(att.path)),
            }
          })
      : []

    if (!cleanMessage && cleanAttachments.length === 0) {
      return res.status(400).json({ error: "Message text or images required." })
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("revision_chat_messages")
      .insert({
        order_id: order.id,
        sender_type: "customer",
        sender_name: order.name || null,
        message: cleanMessage || null,
        attachments: cleanAttachments,
        is_read_by_customer: true,
        is_read_by_admin: false,
      })
      .select("*")
      .single()

    if (insertErr) {
      console.error("❌ Customer chat message insert failed:", insertErr)
      return res.status(500).json({ error: "Could not send message." })
    }

    await sendEmailSafe({
      to: REVIEW_NOTIFICATION_EMAIL,
      subject: `New review chat message — ${order.name || "Customer"}`,
      html: brandedEmailTemplate({
        title: "New customer message",
        bodyHtml:
          emailParagraph("A customer has sent a new message in the review chat.") +
          emailDetails([
            { label: "Order", value: order.razorpay_order_id || order.id },
            { label: "Customer", value: order.name || "" },
            { label: "Email", value: order.email || "" },
            { label: "Edition", value: order.edition || "" },
            { label: "Message", value: nl2br(cleanMessage || "(images only)"), html: true },
            { label: "Images", value: cleanAttachments.length ? `${cleanAttachments.length} attached` : "None" },
          ]),
      }),
    })

    const signed = (await withSignedChatMessages([inserted]))[0]
    return res.json({ success: true, message: signed })
  } catch (err) {
    console.error("❌ /portal/revision-chat-message error:", safeErr(err))
    return res.status(500).json({ error: "Could not send chat message" })
  }
})

/* =========================
   SOULSCRIPT LEGACY ADMIN API
========================= */
const adminCrypto = crypto

const ADMIN_ALLOWED_ORIGINS = new Set([
  "https://admin.soulscriptlegacy.com",
  "https://soulscript-admin.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
])

const ADMIN_TOKEN_TTL_SECONDS = 60 * 60 * 12
const ADMIN_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class AdminInputError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

function isAllowedAdminOrigin(origin) {
  if (!origin) return false
  if (ADMIN_ALLOWED_ORIGINS.has(origin)) return true

  try {
    const url = new URL(origin)
    return url.hostname.endsWith(".vercel.app")
  } catch {
    return false
  }
}

app.use("/admin", (req, res, next) => {
  const origin = req.headers.origin

  if (isAllowedAdminOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin)
    res.setHeader("Vary", "Origin")
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")

  if (req.method === "OPTIONS") return res.sendStatus(204)
  return next()
})

function adminJsonError(res, status, message) {
  return res.status(status).json({ success: false, message })
}

function adminAsync(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next)
    } catch (error) {
      if (error instanceof AdminInputError) return adminJsonError(res, error.status, error.message)
      console.error("Admin route error:", error)
      return adminJsonError(res, 500, "Admin request failed.")
    }
  }
}

function adminConfig() {
  const email = process.env.ADMIN_PANEL_EMAIL
  const password = process.env.ADMIN_PANEL_PASSWORD
  const secret = process.env.ADMIN_JWT_SECRET || process.env.ADMIN_SESSION_SECRET

  if (!email || !password || !secret) return null
  return { email, password, secret }
}

function adminSecureEqual(left, right) {
  const leftHash = adminCrypto.createHash("sha256").update(String(left)).digest()
  const rightHash = adminCrypto.createHash("sha256").update(String(right)).digest()
  return adminCrypto.timingSafeEqual(leftHash, rightHash)
}

function adminSignToken(input) {
  const config = adminConfig()
  if (!config) throw new Error("Admin auth environment variables are missing.")

  return adminCrypto.createHmac("sha256", config.secret).update(input).digest("base64url")
}

function adminCreateToken(email) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(JSON.stringify({ sub: "soulscript-admin", email, iat: now, exp: now + ADMIN_TOKEN_TTL_SECONDS })).toString("base64url")
  const signature = adminSignToken(`${header}.${payload}`)
  return `${header}.${payload}.${signature}`
}

function adminVerifyToken(token) {
  if (!token || typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts
  const expectedSignature = adminSignToken(`${header}.${payload}`)
  if (!adminSecureEqual(signature, expectedSignature)) return null

  let parsed
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }

  if (parsed.sub !== "soulscript-admin") return null
  if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) return null
  return parsed
}

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || ""
  const [scheme, token] = authHeader.split(" ")

  if (scheme !== "Bearer" || !token) return adminJsonError(res, 401, "Admin authentication required.")

  let admin
  try {
    admin = adminVerifyToken(token)
  } catch (error) {
    console.error("Admin token verification failed:", error)
    return adminJsonError(res, 401, "Invalid admin session.")
  }

  if (!admin) return adminJsonError(res, 401, "Invalid admin session.")

  req.admin = admin
  return next()
}

function adminRequireUuid(id, label = "id") {
  if (!id || !ADMIN_UUID_RE.test(String(id))) throw new AdminInputError(`Invalid ${label}.`)
  return String(id)
}

function adminHasOwn(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key)
}

function adminStringOrNull(value, field, maxLength) {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== "string") throw new AdminInputError(`${field} must be a string.`)
  const trimmed = value.trim()
  if (trimmed.length > maxLength) throw new AdminInputError(`${field} is too long.`)
  return trimmed || null
}

function adminNumberOrNull(value, field) {
  if (value === undefined) return undefined
  if (value === null || value === "") return null
  const numberValue = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue < 0) throw new AdminInputError(`${field} must be a non-negative number.`)
  return numberValue
}

function adminBoolean(value, field) {
  if (value === undefined) return undefined
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  throw new AdminInputError(`${field} must be a boolean.`)
}

function adminRevisionStatus(value) {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new AdminInputError("status must be a string.")
  const status = value.trim()
  if (!/^[a-zA-Z0-9 _-]{1,60}$/.test(status)) throw new AdminInputError("status contains invalid characters.")
  return status
}

function adminHandleSupabaseError(res, error, message = "Database request failed.") {
  console.error(message, error)
  return adminJsonError(res, 500, message)
}

const uploadReviewFilesMiddleware = upload.fields([
  { name: "manuscript_pdf", maxCount: 1 },
  { name: "cover_file", maxCount: 1 },
  { name: "manuscriptPdf", maxCount: 1 },
  { name: "coverFile", maxCount: 1 },
  { name: "pdf", maxCount: 1 },
  { name: "cover", maxCount: 1 },
])

function adminUploadReviewFiles(req, res, next) {
  uploadReviewFilesMiddleware(req, res, (error) => {
    if (!error) return next()

    console.error("❌ Admin upload middleware failed:", safeErr(error))
    return adminJsonError(res, 400, error?.message || "File upload failed.")
  })
}

const ADMIN_ORDER_LIST_FIELDS = [
  "id",
  "razorpay_order_id",
  "razorpay_payment_id",
  "edition",
  "payment_type",
  "amount",
  "total_order_value",
  "pending_amount",
  "paid_amount",
  "balance_due",
  "balance_paid_at",
  "name",
  "phone",
  "email",
  "address",
  "created_at",
  "story",
  "story_submitted",
  "story_submitted_at",
  "order_status",
  "production_status",
  "print_requested_at",
  "print_approved_at",
  "sent_to_print_at",
  "latest_review_file_id",
  "custom_cover_paid",
  "voice_note_addon_paid",
  "print_submission_status",
  "print_submission_completed_at",
  "submitted_to_printer",
  "print_order_number",
  "shipment_status",
  "pincode",
  "tracking_number",
  "awb_number",
  "shipping_label_path",
  "shipping_label_url",
  "payout_paid",
  "payout_paid_at",
  "manager_name",
  "writer_name",
  "manager_payout",
  "writer_payout",
  "white_labeling",
].join(",")

const ADMIN_ORDER_DETAIL_FIELDS = ADMIN_ORDER_LIST_FIELDS

const MANAGER_ORDER_FIELDS = [
  "id",
  "edition",
  "payment_type",
  "amount",
  "paid_amount",
  "balance_due",
  "pending_amount",
  "name",
  "phone",
  "email",
  "address",
  "created_at",
  "story",
  "story_submitted",
  "story_submitted_at",
  "order_status",
  "production_status",
  "print_requested_at",
  "latest_review_file_id",
  "custom_cover_paid",
  "voice_note_addon_paid",
  "print_submission_status",
  "print_submission_completed_at",
  "submitted_to_printer",
  "print_order_number",
  "shipment_status",
  "pincode",
  "tracking_number",
  "awb_number",
  "shipping_label_path",
  "shipping_label_url",
  "white_labeling",
].join(",")

app.post("/admin/login", adminAsync(async (req, res) => {
  const config = adminConfig()
  if (!config) return adminJsonError(res, 500, "Admin auth is not configured.")

  const email = adminStringOrNull(req.body && req.body.email, "email", 320)
  const password = adminStringOrNull(req.body && req.body.password, "password", 1000)

  if (!email || !password) return adminJsonError(res, 400, "Email and password are required.")

  const emailMatches = adminSecureEqual(email.toLowerCase(), config.email.toLowerCase())
  const passwordMatches = adminSecureEqual(password, config.password)

  if (!emailMatches || !passwordMatches) return adminJsonError(res, 401, "Invalid admin credentials.")

  return res.json({ success: true, adminToken: adminCreateToken(config.email) })
}))

app.get("/admin/extra-writing-requests", requireAdmin, adminAsync(async (req, res) => {
    const { data: requests, error } = await supabase
        .from("extra_writing_requests")
        .select("*")
        .eq("payment_status", "paid")
        .order("created_at", { ascending: false })

    if (error) return adminHandleSupabaseError(res, error, "Unable to load extra writing requests.")

    if (!requests || requests.length === 0) {
        return res.json({ success: true, requests: [] })
    }

    const orderIds = [...new Set(requests.map((r) => r.order_id))]
    const { data: orders } = await supabase
        .from("orders")
        .select("id, razorpay_order_id, edition, name, email, phone")
        .in("id", orderIds)

    const orderMap = {}
    for (const order of orders || []) {
        orderMap[order.id] = order
    }

    const enriched = requests.map((r) => ({
        ...r,
        order: orderMap[r.order_id] || null,
    }))

    return res.json({ success: true, requests: enriched })
}))

app.patch("/admin/extra-writing-requests/:id", requireAdmin, adminAsync(async (req, res) => {
    const id = adminRequireUuid(req.params.id, "extra writing request id")
    const updates = {}

    if (req.body.status !== undefined) {
        const allowed = ["pending", "in_progress", "completed", "cancelled"]
        if (!allowed.includes(req.body.status)) {
            return adminJsonError(res, 400, "Invalid status")
        }
        updates.status = req.body.status
    }

    if (req.body.writer_name !== undefined) {
        updates.writer_name = req.body.writer_name ? String(req.body.writer_name).trim().slice(0, 180) : null
    }

    if (req.body.writer_payout !== undefined) {
        const payout = Number(req.body.writer_payout)
        if (!Number.isFinite(payout) || payout < 0) {
            return adminJsonError(res, 400, "Invalid writer_payout")
        }
        updates.writer_payout = payout
    }

    if (req.body.payout_paid !== undefined) {
        updates.payout_paid = Boolean(req.body.payout_paid)
        updates.payout_paid_at = req.body.payout_paid ? new Date().toISOString() : null
    }

    if (Object.keys(updates).length === 0) {
        return adminJsonError(res, 400, "No allowed fields provided")
    }

    const { data, error } = await supabase
        .from("extra_writing_requests")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single()

    if (error) {
        if (error.code === "PGRST116") return adminJsonError(res, 404, "Request not found.")
        return adminHandleSupabaseError(res, error, "Unable to update extra writing request.")
    }

    return res.json({ success: true, request: data })
}))

app.get("/admin/me", requireAdmin, adminAsync(async (req, res) => {
  return res.json({ success: true, admin: { email: req.admin.email } })
}))

app.get("/admin/dashboard", requireAdmin, adminAsync(async (req, res) => {
  const [ordersResult, revisionsResult, deliverablesResult, addonsResult] = await Promise.all([
    supabase.from("orders").select("amount, paid_amount, story_submitted"),
    supabase.from("revisions").select("status"),
    supabase.from("deliverables").select("delivered_at"),
    supabase.from("order_addons").select("amount, status, payment_status"),
  ])

  if (ordersResult.error) return adminHandleSupabaseError(res, ordersResult.error, "Unable to load dashboard orders.")
  if (revisionsResult.error) return adminHandleSupabaseError(res, revisionsResult.error, "Unable to load dashboard revisions.")
  if (deliverablesResult.error) return adminHandleSupabaseError(res, deliverablesResult.error, "Unable to load dashboard deliverables.")
  if (addonsResult.error) return adminHandleSupabaseError(res, addonsResult.error, "Unable to load dashboard add-ons.")

  const orders = ordersResult.data || []
  const revisions = revisionsResult.data || []
  const deliverables = deliverablesResult.data || []
  const addons = addonsResult.data || []
  const closedRevisionStatuses = new Set(["complete", "completed", "done", "resolved", "cancelled", "canceled"])

  const orderRevenue = orders.reduce((sum, order) => {
    const amount = Number(order.paid_amount || order.amount || 0)
    return Number.isFinite(amount) ? sum + amount : sum
  }, 0)

  const addonRevenue = addons
    .filter((addon) => addonIsPaid(addon))
    .reduce((sum, addon) => {
      const amount = Number(addon.amount || 0)
      return Number.isFinite(amount) ? sum + amount : sum
    }, 0)

  return res.json({
    success: true,
    dashboard: {
      total_orders: orders.length,
      pending_story_submissions: orders.filter((order) => !order.story_submitted).length,
      submitted_stories: orders.filter((order) => order.story_submitted).length,
      pending_revisions: revisions.filter((revision) => {
        const status = String(revision.status || "pending").toLowerCase()
        return !closedRevisionStatuses.has(status)
      }).length,
      pending_deliverables: deliverables.filter((deliverable) => !deliverable.delivered_at).length,
      total_revenue_collected: orderRevenue + addonRevenue,
      addon_revenue_collected: addonRevenue,
    },
  })
}))

app.get("/admin/orders", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase
    .from("orders")
    .select(ADMIN_ORDER_LIST_FIELDS)
    .order("created_at", { ascending: false })

  if (error) return adminHandleSupabaseError(res, error, "Unable to load orders.")

  return res.json({ success: true, orders: data || [] })
}))

app.get("/admin/storage/signed-url", requireAdmin, adminAsync(async (req, res) => {
  const bucket = String(req.query.bucket || "").trim()
  const path = String(req.query.path || "").trim()

  if (!bucket) return adminJsonError(res, 400, "bucket is required.")
  if (!path) return adminJsonError(res, 400, "path is required.")

  const allowedBuckets = new Set(Object.values(STORAGE_BUCKETS))
  if (!allowedBuckets.has(bucket)) {
    return adminJsonError(res, 400, "Storage bucket is not allowed.")
  }

  const signedUrl = await createSignedUrl(bucket, path)
  if (!signedUrl) return adminJsonError(res, 404, "Could not create signed URL.")

  return res.json({ success: true, signedUrl })
}))

/* =========================
   PHASE 1: DOWNLOAD STORY AS .TXT
========================= */
app.get("/admin/orders/:id/download-story", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, razorpay_order_id, name, edition, story")
    .eq("id", id)
    .single()

  if (error || !order) {
    if (error?.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, error, "Unable to load order.")
  }

  // Try story from orders table first; fall back to latest submitted story_intake
  let storyText = String(order.story || "").trim()

  if (!storyText) {
    const { data: intakes } = await supabase
      .from("story_intakes")
      .select("text_story, submitted, submitted_at")
      .eq("order_id", id)
      .order("updated_at", { ascending: false })

    const submittedIntake = (intakes || []).find((i) => i.submitted === true && i.submitted_at)
    const fallbackIntake = submittedIntake || (intakes || [])[0]

    if (fallbackIntake?.text_story) {
      storyText = String(fallbackIntake.text_story).trim()
    }
  }

  if (!storyText) {
    return adminJsonError(res, 404, "No story text found for this order.")
  }

  const customerName = (order.name || "customer").replace(/[^a-zA-Z0-9 _-]/g, "_").trim() || "customer"
  const orderRef = order.razorpay_order_id || id
  const fileName = safeFileName(`story-${customerName}-${orderRef}.txt`)

  // Add a header inside the file so writer knows context
  const header = [
    `SoulScript Legacy — Story Submission`,
    `Customer: ${order.name || ""}`,
    `Edition: ${order.edition || ""}`,
    `Order Number: ${order.razorpay_order_id || ""}`,
    `Downloaded: ${new Date().toISOString()}`,
    "",
    "----------------------------------------",
    "",
  ].join("\n")

  const finalContent = header + storyText + "\n"

  res.setHeader("Content-Type", "text/plain; charset=utf-8")
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`)
  res.setHeader("Cache-Control", "no-store")
  return res.send(finalContent)
}))

/* =========================
   PHASE 1: DOWNLOAD ALL VOICE NOTES AS ZIP
========================= */
app.get("/admin/orders/:id/download-voice-notes", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, razorpay_order_id, name, edition")
    .eq("id", id)
    .single()

  if (orderErr || !order) {
    if (orderErr?.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, orderErr, "Unable to load order.")
  }

  const { data: voiceNotes, error: vnErr } = await supabase
    .from("voice_notes")
    .select("*")
    .eq("order_id", id)
    .order("created_at", { ascending: true })

  if (vnErr) return adminHandleSupabaseError(res, vnErr, "Unable to load voice notes.")

  if (!voiceNotes || voiceNotes.length === 0) {
    return adminJsonError(res, 404, "No voice notes found for this order.")
  }

  const customerName = (order.name || "customer").replace(/[^a-zA-Z0-9 _-]/g, "_").trim() || "customer"
  const orderRef = order.razorpay_order_id || id
  const zipFileName = safeFileName(`voice-notes-${customerName}-${orderRef}.zip`)

  res.setHeader("Content-Type", "application/zip")
  res.setHeader("Content-Disposition", `attachment; filename="${zipFileName}"`)
  res.setHeader("Cache-Control", "no-store")

  const archive = archiver("zip", { zlib: { level: 6 } })

  archive.on("error", (err) => {
    console.error("❌ Voice notes archive error:", err)
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Could not build zip" })
    } else {
      res.end()
    }
  })

  archive.pipe(res)

  // Build a manifest text file with metadata
  const manifestLines = [
    `SoulScript Legacy — Voice Notes`,
    `Customer: ${order.name || ""}`,
    `Edition: ${order.edition || ""}`,
    `Order Number: ${order.razorpay_order_id || ""}`,
    `Total Voice Notes: ${voiceNotes.length}`,
    `Downloaded: ${new Date().toISOString()}`,
    "",
    "Files included:",
  ]

  let added = 0
  for (let i = 0; i < voiceNotes.length; i++) {
    const vn = voiceNotes[i]
    if (!vn.file_path) continue

    const buffer = await downloadStorageFileBuffer(STORAGE_BUCKETS.voiceNotes, vn.file_path)
    if (!buffer) {
      manifestLines.push(`  - [MISSING] ${vn.file_name || basenameFromPath(vn.file_path)}`)
      continue
    }

    const originalName = vn.file_name || basenameFromPath(vn.file_path) || `voice-note-${i + 1}`
    const safeName = safeFileName(originalName)
    const numberedName = `${String(i + 1).padStart(2, "0")}-${safeName}`

    archive.append(buffer, { name: numberedName })
    manifestLines.push(`  ${i + 1}. ${numberedName} (${Math.round(Number(vn.duration_seconds || 0))}s)`)
    added += 1
  }

  archive.append(manifestLines.join("\n") + "\n", { name: "MANIFEST.txt" })

  if (added === 0) {
    archive.append("No voice note files could be retrieved from storage.\n", { name: "ERROR.txt" })
  }

  await archive.finalize()
}))

/* =========================
   PHASE 1: DOWNLOAD COVER MATERIAL AS ZIP
========================= */
app.get("/admin/orders/:id/download-cover-material", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, razorpay_order_id, name, edition, custom_cover_paid")
    .eq("id", id)
    .single()

  if (orderErr || !order) {
    if (orderErr?.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, orderErr, "Unable to load order.")
  }

  // Find the latest submitted intake (or latest draft if none submitted)
  const { data: intakes, error: intakeErr } = await supabase
    .from("story_intakes")
    .select("*")
    .eq("order_id", id)
    .order("updated_at", { ascending: false })

  if (intakeErr) return adminHandleSupabaseError(res, intakeErr, "Unable to load story intake.")

  const submittedIntake = (intakes || []).find((i) => i.submitted === true && i.submitted_at)
  const intake = submittedIntake || (intakes || [])[0] || null

  if (!intake) {
    return adminJsonError(res, 404, "No story intake found for this order.")
  }

  const isCustomCover =
    order.custom_cover_paid === true ||
    String(intake.cover_mode || "").toLowerCase() === "custom"

  const customerName = (order.name || "customer").replace(/[^a-zA-Z0-9 _-]/g, "_").trim() || "customer"
  const orderRef = order.razorpay_order_id || id
  const zipFileName = safeFileName(`cover-material-${customerName}-${orderRef}.zip`)

  res.setHeader("Content-Type", "application/zip")
  res.setHeader("Content-Disposition", `attachment; filename="${zipFileName}"`)
  res.setHeader("Cache-Control", "no-store")

  const archive = archiver("zip", { zlib: { level: 6 } })

  archive.on("error", (err) => {
    console.error("❌ Cover material archive error:", err)
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: "Could not build zip" })
    } else {
      res.end()
    }
  })

  archive.pipe(res)

  // Always include a cover-info.txt with title, author, edition, custom notes if any
  const infoLines = [
    `SoulScript Legacy — Cover Material`,
    `Customer: ${order.name || ""}`,
    `Edition: ${order.edition || ""}`,
    `Order Number: ${order.razorpay_order_id || ""}`,
    `Cover Type: ${isCustomCover ? "CUSTOM (paid)" : "Default template"}`,
    `Downloaded: ${new Date().toISOString()}`,
    "",
    "----------------------------------------",
    "",
    `Title: ${intake.title || intake.cover_title || "(not provided)"}`,
    `Author Name: ${intake.author_name || "(not provided)"}`,
    "",
  ]

  if (isCustomCover) {
    infoLines.push("----------------------------------------")
    infoLines.push("")
    infoLines.push("CUSTOM COVER NOTES (customer's description):")
    infoLines.push("")
    infoLines.push(intake.custom_cover_notes || intake.cover_notes || "(no notes provided)")
    infoLines.push("")
  }

  archive.append(infoLines.join("\n") + "\n", { name: "cover-info.txt" })

  if (isCustomCover) {
    // Custom cover: include up to 3 reference images
    const referencePaths = normalizeStoragePathArray(intake.reference_image_paths, 10)

    if (referencePaths.length === 0) {
      archive.append(
        "Customer purchased custom cover but no reference images were uploaded.\n",
        { name: "REFERENCES-NOTE.txt" }
      )
    } else {
      let added = 0
      for (let i = 0; i < referencePaths.length; i++) {
        const path = referencePaths[i]
        const result = await downloadStorageFileWithFallback(
          [
            STORAGE_BUCKETS.coverReferences,
            STORAGE_BUCKETS.reviewMedia,
            STORAGE_BUCKETS.coverPhotos,
          ],
          path
        )

        if (!result) continue

        const originalName = basenameFromPath(path) || `reference-${i + 1}`
        const safeName = safeFileName(originalName)
        const numberedName = `reference-${String(i + 1).padStart(2, "0")}-${safeName}`

        archive.append(result.buffer, { name: numberedName })
        added += 1
      }

      if (added === 0) {
        archive.append(
          "Reference images are listed in the database but could not be retrieved from storage.\n",
          { name: "REFERENCES-ERROR.txt" }
        )
      }
    }
  } else {
    // Default cover: include cover photo if any (Confession edition has none)
    const coverPhotoPath = firstNonEmpty(intake.cover_photo_path, intake.photo_path)

    if (!coverPhotoPath) {
      if (order.edition === "Confession Edition") {
        archive.append(
          "Confession Edition uses title and author name only. No cover photo applies.\n",
          { name: "COVER-PHOTO-NOTE.txt" }
        )
      } else {
        archive.append(
          "No cover photo was uploaded by the customer.\n",
          { name: "COVER-PHOTO-NOTE.txt" }
        )
      }
    } else {
      const result = await downloadStorageFileWithFallback(
        [
          STORAGE_BUCKETS.coverPhotos,
          STORAGE_BUCKETS.reviewMedia,
          STORAGE_BUCKETS.coverReferences,
        ],
        coverPhotoPath
      )

      if (!result) {
        archive.append(
          `Cover photo path stored: ${coverPhotoPath}\nBut file could not be retrieved from storage.\n`,
          { name: "COVER-PHOTO-ERROR.txt" }
        )
      } else {
        const originalName = basenameFromPath(coverPhotoPath) || "cover-photo"
        const safeName = safeFileName(originalName)
        archive.append(result.buffer, { name: `cover-photo-${safeName}` })
      }
    }
  }

  await archive.finalize()
}))

app.get("/admin/orders/:id/files", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")

  const [
    orderResult,
    storyIntakesResult,
    voiceNotesResult,
    coverReferencesResult,
    polaroidsResult,
    deliverablesResult,
    reviewFilesResult,
  ] = await Promise.all([
    supabase.from("orders").select("id, name, email, phone, edition").eq("id", id).single(),
    supabase.from("story_intakes").select("*").eq("order_id", id).order("updated_at", { ascending: false }),
    supabase.from("voice_notes").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("cover_reference_images").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("polaroid_photos").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("deliverables").select("*").eq("order_id", id).order("uploaded_at", { ascending: false }),
    supabase.from("review_files").select("*").eq("order_id", id).order("created_at", { ascending: false }),
  ])

  if (orderResult.error) {
    if (orderResult.error.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, orderResult.error, "Unable to load order.")
  }

  const relatedError = [
    storyIntakesResult,
    voiceNotesResult,
    coverReferencesResult,
    polaroidsResult,
    deliverablesResult,
    reviewFilesResult,
  ].find((result) => result.error)

  if (relatedError) return adminHandleSupabaseError(res, relatedError.error, "Unable to load order files.")

  const storyIntakes = await Promise.all(
    (storyIntakesResult.data || []).map((intake) => withSignedStoryIntake(intake))
  )

  return res.json({
    success: true,
    order: orderResult.data,
    files: {
      story_intakes: storyIntakes,
      voice_notes: await withSignedVoiceNotes(voiceNotesResult.data || []),
      cover_reference_images: await withSignedCoverReferenceImages(coverReferencesResult.data || []),
      polaroid_photos: await withSignedPolaroids(polaroidsResult.data || []),
      deliverables: await withSignedDeliverables(deliverablesResult.data || []),
      review_files: await withSignedReviewFiles(reviewFilesResult.data || []),
    },
  })
}))

app.get("/admin/manager/orders/:id", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")

  const orderResult = await supabase
    .from("orders")
    .select(MANAGER_ORDER_FIELDS)
    .eq("id", id)
    .single()

  if (orderResult.error) {
    if (orderResult.error.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, orderResult.error, "Unable to load manager order.")
  }

  const [
    storyIntakesResult,
    voiceNotesResult,
    coverReferencesResult,
    callBookingsResult,
    deliverablesResult,
    revisionsResult,
    addonsResult,
    reviewFilesResult,
    polaroidsResult,
  ] = await Promise.all([
    supabase.from("story_intakes").select("*").eq("order_id", id).order("updated_at", { ascending: false }),
    supabase.from("voice_notes").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("cover_reference_images").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("call_bookings").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("deliverables").select("*").eq("order_id", id).order("uploaded_at", { ascending: false }),
    supabase.from("revisions").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("order_addons").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("review_files").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("polaroid_photos").select("*").eq("order_id", id).order("created_at", { ascending: false }),
  ])

  const relatedError = [
    storyIntakesResult,
    voiceNotesResult,
    coverReferencesResult,
    callBookingsResult,
    deliverablesResult,
    revisionsResult,
    addonsResult,
    reviewFilesResult,
    polaroidsResult,
  ].find((result) => result.error)

  if (relatedError) return adminHandleSupabaseError(res, relatedError.error, "Unable to load manager order data.")

  const storyIntakes = storyIntakesResult.data || []
  const activeStoryIntake =
    storyIntakes.find((item) => item.submitted === true && item.submitted_at) ||
    storyIntakes.find((item) => item.submitted !== true && !item.submitted_at) ||
    storyIntakes[0] ||
    null

  const signedStoryIntake = await withSignedStoryIntake(activeStoryIntake)
  const signedCoverReferences = await withSignedCoverReferenceImages(coverReferencesResult.data || [])
  const referenceImagesFromIntake = signedStoryIntake?.reference_images || []
  const referenceImages = [
    ...referenceImagesFromIntake,
    ...signedCoverReferences.map((image) => ({
      id: image.id,
      file_path: image.file_path,
      file_name: image.file_name,
      signed_url: image.signed_url,
      created_at: image.created_at,
    })),
  ]

  const signedReviewFiles = await withSignedReviewFiles(reviewFilesResult.data || [])
  const signedDeliverables = await withSignedDeliverables(deliverablesResult.data || [])
  const latestReviewFile =
    signedReviewFiles.find((item) => item.id === orderResult.data.latest_review_file_id) ||
    signedReviewFiles[0] ||
    null

  return res.json({
    success: true,
    order: {
      ...orderResult.data,
      story_intake: signedStoryIntake,
      story_intakes: await Promise.all(storyIntakes.map((intake) => withSignedStoryIntake(intake))),
      cover_photo: signedStoryIntake?.cover_photo || null,
      reference_images: referenceImages,
      voice_notes: await withSignedVoiceNotes(voiceNotesResult.data || []),
      call_bookings: callBookingsResult.data || [],
      deliverables: signedDeliverables,
      revisions: revisionsResult.data || [],
      addons: (addonsResult.data || []).map(sanitizeManagerAddon),
      review_files: signedReviewFiles,
      latest_review_file: latestReviewFile,
      polaroid_photos: await withSignedPolaroids(polaroidsResult.data || []),
      ultra_priority: (addonsResult.data || []).some(addonLooksUltraPriority),
    },
  })
}))

app.get("/admin/orders/:id", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")

  const orderResult = await supabase.from("orders").select(ADMIN_ORDER_DETAIL_FIELDS).eq("id", id).single()
  if (orderResult.error) {
    if (orderResult.error.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, orderResult.error, "Unable to load order.")
  }

  const [
    storyIntakesResult,
    voiceNotesResult,
    coverReferencesResult,
    callBookingsResult,
    deliverablesResult,
    revisionsResult,
    addonsResult,
    reviewFilesResult,
    polaroidsResult,
  ] = await Promise.all([
    supabase.from("story_intakes").select("*").eq("order_id", id).order("updated_at", { ascending: false }),
    supabase.from("voice_notes").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("cover_reference_images").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("call_bookings").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("deliverables").select("*").eq("order_id", id).order("uploaded_at", { ascending: false }),
    supabase.from("revisions").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("order_addons").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("review_files").select("*").eq("order_id", id).order("created_at", { ascending: false }),
    supabase.from("polaroid_photos").select("*").eq("order_id", id).order("created_at", { ascending: false }),
  ])

  const relatedResults = [
    storyIntakesResult,
    voiceNotesResult,
    coverReferencesResult,
    callBookingsResult,
    deliverablesResult,
    revisionsResult,
    addonsResult,
    reviewFilesResult,
    polaroidsResult,
  ]

  const relatedError = relatedResults.find((result) => result.error)
  if (relatedError) return adminHandleSupabaseError(res, relatedError.error, "Unable to load related order data.")

  const storyIntakes = storyIntakesResult.data || []
  const activeStoryIntake =
    storyIntakes.find((item) => item.submitted === true && item.submitted_at) ||
    storyIntakes.find((item) => item.submitted !== true && !item.submitted_at) ||
    storyIntakes[0] ||
    null

  const signedReviewFiles = await withSignedReviewFiles(reviewFilesResult.data || [])
  const signedDeliverables = await withSignedDeliverables(deliverablesResult.data || [])

  return res.json({
    success: true,
    order: {
      ...orderResult.data,
      story_intake: await withSignedStoryIntake(activeStoryIntake),
      story_intakes: await Promise.all(storyIntakes.map((intake) => withSignedStoryIntake(intake))),
      voice_notes: await withSignedVoiceNotes(voiceNotesResult.data || []),
      cover_reference_images: await withSignedCoverReferenceImages(coverReferencesResult.data || []),
      call_bookings: callBookingsResult.data || [],
      deliverables: signedDeliverables,
      revisions: revisionsResult.data || [],
      addons: addonsResult.data || [],
      review_files: signedReviewFiles,
      polaroid_photos: await withSignedPolaroids(polaroidsResult.data || []),
      latest_review_file:
        signedReviewFiles.find((item) => item.id === orderResult.data.latest_review_file_id) ||
        signedReviewFiles[0] ||
        null,
      ultra_priority: (addonsResult.data || []).some(addonLooksUltraPriority),
    },
  })
}))

app.post("/admin/orders/:id/send-story-reminder", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")

  const { data: order, error } = await supabase
    .from("orders")
    .select("id, razorpay_order_id, edition, name, email, phone, story_submitted")
    .eq("id", id)
    .single()

  if (error || !order) {
    if (error?.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, error, "Unable to load order.")
  }

  if (order.story_submitted) {
    return adminJsonError(res, 409, "Story has already been submitted.")
  }

  const customerEmail = normalizeEmail(order.email)

  if (!customerEmail || !customerEmail.includes("@")) {
    return adminJsonError(res, 400, "Customer email is missing or invalid.")
  }

  if (!order.razorpay_order_id) {
    return adminJsonError(res, 400, "Razorpay order ID is missing.")
  }

  const portalUrl = `${PORTAL_BASE_URL}/story?order=${encodeURIComponent(order.razorpay_order_id)}`
  const customerName = String(order.name || "").trim() || "SoulScript customer"
  const editionName = String(order.edition || "SoulScript Legacy edition").trim()

  const sent = await sendEmailSafe({
    to: customerEmail,
    subject: "Complete your SoulScript Legacy story",
    html: brandedEmailTemplate({
      title: "Your story portal is waiting",
      bodyHtml:
        emailParagraph(`Dear ${escapeHtml(customerName)},`) +
        emailParagraph("This is a gentle reminder to complete your SoulScript Legacy story submission.") +
        emailParagraph(`Your ${escapeHtml(editionName)} can move into the writing process once your story details are shared with us.`),
      ctaLabel: "Open Story Portal",
      ctaUrl: portalUrl,
    }),
  })

  if (!sent.ok) {
    return res.status(502).json({
      success: false,
      message: "Reminder email could not be sent.",
      error: sent.error,
      portalUrl,
      order_id: order.id,
      razorpay_order_id: order.razorpay_order_id,
    })
  }

  return res.json({
    success: true,
    message: "Story reminder email sent.",
    to: customerEmail,
    portalUrl,
    order_id: order.id,
    razorpay_order_id: order.razorpay_order_id,
  })
}))

/* =========================
   ADMIN: UPLOAD REVIEW FILES
   PHASE 1: Now also accepts optional title and author_name
   to fill in if customer didn't provide them in story intake.
========================= */
async function handleAdminUploadReviewFiles(req, res) {
    try {
      const id = adminRequireUuid(req.params.id, "order id")

      const manuscriptFile = uploadedFile(req, ["manuscript_pdf", "manuscriptPdf", "pdf"])
      const coverFile = uploadedFile(req, ["cover_file", "coverFile", "cover"])
      const managerNote = normalizeText(req.body?.manager_note ?? req.body?.managerNote ?? "", 4000) || null

      // PHASE 1: Optional title and author_name from manager (if customer didn't provide them)
      const managerTitle = normalizeText(req.body?.title ?? req.body?.cover_title ?? "", 300)
      const managerAuthorName = normalizeText(req.body?.author_name ?? req.body?.authorName ?? "", 180)

      if (!manuscriptFile && !coverFile) {
        return adminJsonError(res, 400, "Upload manuscript PDF or cover file.")
      }

      if (manuscriptFile && manuscriptFile.mimetype !== "application/pdf") {
        return adminJsonError(res, 400, "Manuscript file must be a PDF.")
      }

      const allowedCoverTypes = new Set([
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp",
      ])

      if (coverFile && !allowedCoverTypes.has(coverFile.mimetype)) {
        return adminJsonError(res, 400, "Cover file must be PDF, JPG, PNG, or WEBP.")
      }

      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("id, razorpay_order_id, name, email, edition")
        .eq("id", id)
        .single()

      if (orderErr || !order) {
        if (orderErr?.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
        return adminHandleSupabaseError(res, orderErr, "Unable to load order.")
      }

      // PHASE 1: If manager provided title/author, backfill them on the latest submitted intake
      // ONLY if those fields are currently empty (we never overwrite customer-provided values)
      if (managerTitle || managerAuthorName) {
        const { data: latestSubmittedIntakes } = await supabase
          .from("story_intakes")
          .select("id, title, cover_title, author_name")
          .eq("order_id", id)
          .order("updated_at", { ascending: false })
          .limit(1)

        const latestIntake = (latestSubmittedIntakes || [])[0]

        if (latestIntake) {
          const intakeUpdate = {}

          const existingTitle = firstNonEmpty(latestIntake.title, latestIntake.cover_title)
          if (managerTitle && !existingTitle) {
            intakeUpdate.title = managerTitle
            intakeUpdate.cover_title = managerTitle
          }

          const existingAuthor = firstNonEmpty(latestIntake.author_name)
          if (managerAuthorName && !existingAuthor) {
            intakeUpdate.author_name = managerAuthorName
          }

          if (Object.keys(intakeUpdate).length > 0) {
            intakeUpdate.updated_at = new Date().toISOString()
            const { error: backfillErr } = await supabase
              .from("story_intakes")
              .update(intakeUpdate)
              .eq("id", latestIntake.id)

            if (backfillErr) {
              console.error("⚠️ Manager title/author backfill failed:", backfillErr)
            }
          }
        }
      }

      const now = new Date().toISOString()
      const versionNumber = await getNextReviewVersion(id)

      const manuscriptPath = manuscriptFile
        ? await uploadReviewStorageFile(id, versionNumber, manuscriptFile, "manuscript")
        : null

      const coverPath = coverFile
        ? await uploadReviewStorageFile(id, versionNumber, coverFile, "cover")
        : null

      const { data: reviewFile, error: reviewFileErr } = await supabase
        .from("review_files")
        .insert({
          order_id: id,
          version_number: versionNumber,
          manuscript_pdf_path: manuscriptPath,
          cover_file_path: coverPath,
          manager_note: managerNote,
          status: "sent_for_review",
          sent_for_review_at: now,
        })
        .select("*")
        .single()

      if (reviewFileErr || !reviewFile) {
        return adminHandleSupabaseError(res, reviewFileErr, "Unable to create review file.")
      }

      const { data: deliverable, error: deliverableErr } = await supabase
        .from("deliverables")
        .insert({
          order_id: id,
          pdf_path: manuscriptPath,
          cover_path: coverPath,
          uploaded_at: now,
          review_file_id: reviewFile.id,
          status: "waiting_customer_review",
        })
        .select("*")
        .single()

      if (deliverableErr || !deliverable) {
        return adminHandleSupabaseError(res, deliverableErr, "Unable to create deliverable.")
      }

      await supabase
        .from("orders")
        .update({
          production_status: "review_ready",
          order_status: "review_ready",
          latest_review_file_id: reviewFile.id,
        })
        .eq("id", id)

      const signedReviewFile = (await withSignedReviewFiles([reviewFile]))[0]
      const signedDeliverable = (await withSignedDeliverables([deliverable]))[0]
      const portalUrl = `${PORTAL_BASE_URL}/story?order=${encodeURIComponent(order.razorpay_order_id)}`

      if (order.email) {
        await sendEmailSafe({
          to: order.email,
          subject: "Your review files are ready",
          html: brandedEmailTemplate({
            title: "Your review files are ready",
            bodyHtml:
              emailParagraph(`Dear ${escapeHtml(order.name || "SoulScript customer")},`) +
              emailParagraph("Your manuscript and cover review files are now available in your story portal.") +
              emailParagraph("Please review them carefully. You can approve them for printing or request changes from the portal.") +
              (managerNote
                ? emailDivider() +
                  emailParagraph("<strong>A note from your team:</strong>") +
                  emailMuted(nl2br(managerNote))
                : ""),
            ctaLabel: "Open Review Portal",
            ctaUrl: portalUrl,
          }),
        })
      }

      return res.json({
        success: true,
        review_file: signedReviewFile,
        deliverable: signedDeliverable,
        signedUrls: {
          manuscript_pdf_url: signedReviewFile?.manuscript_pdf_signed_url || null,
          cover_file_url: signedReviewFile?.cover_file_signed_url || null,
        },
      })    } catch (err) {
        if (typeof Sentry !== "undefined" && process.env.SENTRY_DSN) {
            Sentry.captureException(err, { tags: { endpoint: "upload-review-files" } })
        }
        console.error("❌ /admin/orders/:id/upload-review-files error:", safeErr(err))
        throw err
    }

}

app.post(
  "/admin/orders/:id/upload-review-files",
  requireAdmin,
  adminUploadReviewFiles,
  adminAsync(handleAdminUploadReviewFiles)
)

// Legacy alias - some older admin clients still POST to the singular path.
app.post(
  "/admin/orders/:id/upload-review-file",
  requireAdmin,
  adminUploadReviewFiles,
  adminAsync(handleAdminUploadReviewFiles)
)

app.patch("/admin/orders/:id", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")
  const updates = {}

  if (adminHasOwn(req.body, "name")) updates.name = adminStringOrNull(req.body.name, "name", 180)
  if (adminHasOwn(req.body, "phone")) updates.phone = adminStringOrNull(req.body.phone, "phone", 40)
  if (adminHasOwn(req.body, "email")) updates.email = normalizeEmail(adminStringOrNull(req.body.email, "email", 320))
  if (adminHasOwn(req.body, "address")) updates.address = adminStringOrNull(req.body.address, "address", 2000)
  if (adminHasOwn(req.body, "edition")) updates.edition = adminStringOrNull(req.body.edition, "edition", 120)
  if (adminHasOwn(req.body, "payment_type")) updates.payment_type = adminStringOrNull(req.body.payment_type, "payment_type", 80)
  if (adminHasOwn(req.body, "amount")) updates.amount = adminNumberOrNull(req.body.amount, "amount")
  if (adminHasOwn(req.body, "total_order_value")) updates.total_order_value = adminNumberOrNull(req.body.total_order_value, "total_order_value")
  if (adminHasOwn(req.body, "pending_amount")) updates.pending_amount = adminNumberOrNull(req.body.pending_amount, "pending_amount")
  if (adminHasOwn(req.body, "paid_amount")) updates.paid_amount = adminNumberOrNull(req.body.paid_amount, "paid_amount")
  if (adminHasOwn(req.body, "balance_due")) updates.balance_due = adminNumberOrNull(req.body.balance_due, "balance_due")
  if (adminHasOwn(req.body, "story_submitted")) updates.story_submitted = adminBoolean(req.body.story_submitted, "story_submitted")
  if (adminHasOwn(req.body, "production_status")) updates.production_status = adminStringOrNull(req.body.production_status, "production_status", 80)
  if (adminHasOwn(req.body, "order_status")) updates.order_status = adminStringOrNull(req.body.order_status, "order_status", 80)
  if (adminHasOwn(req.body, "custom_cover_paid")) updates.custom_cover_paid = adminBoolean(req.body.custom_cover_paid, "custom_cover_paid")
  if (adminHasOwn(req.body, "voice_note_addon_paid")) updates.voice_note_addon_paid = adminBoolean(req.body.voice_note_addon_paid, "voice_note_addon_paid")
  if (adminHasOwn(req.body, "white_labeling")) updates.white_labeling = adminBoolean(req.body.white_labeling, "white_labeling")

  if (Object.keys(updates).length === 0) return adminJsonError(res, 400, "No allowed order fields provided.")

  const { data, error } = await supabase.from("orders").update(updates).eq("id", id).select(ADMIN_ORDER_DETAIL_FIELDS).single()
  if (error) {
    if (error.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, error, "Unable to update order.")
  }

  return res.json({ success: true, order: data })
}))

/* =========================
   ADMIN: PRINT SUBMISSION
========================= */
app.patch("/admin/orders/:id/print-submission", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")

  const printSubmissionStatus = adminBoolean(req.body?.print_submission_status, "print_submission_status")
  const submittedToPrinter = adminBoolean(req.body?.submitted_to_printer, "submitted_to_printer")

  if (printSubmissionStatus === undefined && submittedToPrinter === undefined) {
    return adminJsonError(res, 400, "Provide print_submission_status or submitted_to_printer.")
  }

  const updates = {}

  const markingSubmitted = printSubmissionStatus === true || submittedToPrinter === true
  const markingUnsubmitted =
    !markingSubmitted &&
    (printSubmissionStatus === false || submittedToPrinter === false)

  if (markingSubmitted) {
    updates.print_submission_status = true
    updates.submitted_to_printer = true
    updates.print_submission_completed_at = new Date().toISOString()
  } else if (markingUnsubmitted) {
    if (printSubmissionStatus === false) updates.print_submission_status = false
    if (submittedToPrinter === false) updates.submitted_to_printer = false
    updates.print_submission_completed_at = null
  }

  const { data, error } = await supabase
    .from("orders")
    .update(updates)
    .eq("id", id)
    .select(ADMIN_ORDER_DETAIL_FIELDS)
    .single()

  if (error) {
    if (error.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, error, "Unable to update print submission.")
  }

  return res.json({ success: true, order: data })
}))

/* =========================
   ADMIN: SHIPMENT
========================= */
const ALLOWED_SHIPMENT_STATUSES = new Set([
  "under_printing",
  "in_transit",
  "delivered",
  "shipped",
  "pending",
])

app.patch("/admin/orders/:id/shipment", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")
  const updates = {}

  if (adminHasOwn(req.body, "print_order_number")) {
    updates.print_order_number = adminStringOrNull(req.body.print_order_number, "print_order_number", 120)
  }

  if (adminHasOwn(req.body, "shipment_status")) {
    const value = req.body.shipment_status
    if (value === null || value === "") {
      updates.shipment_status = null
    } else {
      const cleaned = adminStringOrNull(value, "shipment_status", 60)
      if (cleaned !== null && !ALLOWED_SHIPMENT_STATUSES.has(cleaned)) {
        return adminJsonError(res, 400, "Invalid shipment_status.")
      }
      updates.shipment_status = cleaned
    }
  }

  if (adminHasOwn(req.body, "address")) {
    updates.address = adminStringOrNull(req.body.address, "address", 2500)
  }

  if (adminHasOwn(req.body, "pincode")) {
    updates.pincode = adminStringOrNull(req.body.pincode, "pincode", 20)
  }

  if (adminHasOwn(req.body, "tracking_number")) {
    updates.tracking_number = adminStringOrNull(req.body.tracking_number, "tracking_number", 160)
  }

  if (adminHasOwn(req.body, "awb_number")) {
    updates.awb_number = adminStringOrNull(req.body.awb_number, "awb_number", 160)
  }

  if (adminHasOwn(req.body, "shipping_label_path")) {
    updates.shipping_label_path = adminStringOrNull(req.body.shipping_label_path, "shipping_label_path", 1200)
  }

  if (adminHasOwn(req.body, "shipping_label_url")) {
    updates.shipping_label_url = adminStringOrNull(req.body.shipping_label_url, "shipping_label_url", 2000)
  }

  if (Object.keys(updates).length === 0) {
    return adminJsonError(res, 400, "No allowed shipment fields provided.")
  }

  if (adminHasOwn(req.body, "shipment_status")) {
    const status = updates.shipment_status
    if (status === "under_printing") {
      updates.production_status = "under_printing"
      updates.order_status = "under_printing"
    } else if (status === "in_transit" || status === "shipped") {
      updates.production_status = "in_transit"
      updates.order_status = "in_transit"
    } else if (status === "delivered") {
      updates.production_status = "delivered"
      updates.order_status = "delivered"
    }
  }

  const { data, error } = await supabase
    .from("orders")
    .update(updates)
    .eq("id", id)
    .select(ADMIN_ORDER_DETAIL_FIELDS)
    .single()

  if (error) {
    if (error.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, error, "Unable to update shipment.")
  }

  if (updates.shipment_status === "delivered") {
    try {
      await supabase
        .from("deliverables")
        .update({ delivered_at: new Date().toISOString() })
        .eq("order_id", id)
        .is("delivered_at", null)
    } catch (deliverableErr) {
      console.warn("⚠️ Could not stamp deliverables.delivered_at:", safeErr(deliverableErr))
    }
  }

  return res.json({ success: true, order: data })
}))

/* =========================
   ADMIN: PAYOUT
========================= */
app.patch("/admin/orders/:id/payout", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")
  const updates = {}

  if (adminHasOwn(req.body, "payout_paid")) {
    const payoutPaid = adminBoolean(req.body.payout_paid, "payout_paid")
    if (payoutPaid !== undefined) {
      updates.payout_paid = payoutPaid
      updates.payout_paid_at = payoutPaid ? new Date().toISOString() : null
    }
  }

  if (adminHasOwn(req.body, "manager_name")) {
    updates.manager_name = adminStringOrNull(req.body.manager_name, "manager_name", 180)
  }

  if (adminHasOwn(req.body, "writer_name")) {
    updates.writer_name = adminStringOrNull(req.body.writer_name, "writer_name", 180)
  }

  if (adminHasOwn(req.body, "manager_payout")) {
    updates.manager_payout = adminNumberOrNull(req.body.manager_payout, "manager_payout")
  }

  if (adminHasOwn(req.body, "writer_payout")) {
    updates.writer_payout = adminNumberOrNull(req.body.writer_payout, "writer_payout")
  }

  if (Object.keys(updates).length === 0) {
    return adminJsonError(res, 400, "No allowed payout fields provided.")
  }

  const { data, error } = await supabase
    .from("orders")
    .update(updates)
    .eq("id", id)
    .select(ADMIN_ORDER_DETAIL_FIELDS)
    .single()

  if (error) {
    if (error.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
    return adminHandleSupabaseError(res, error, "Unable to update payout.")
  }

  return res.json({ success: true, order: data })
}))

/* =========================
   ADMIN: REVIEW CHAT (revision_messages)
========================= */
const ALLOWED_REVISION_MESSAGE_SENDERS = new Set(["admin", "customer", "system"])

app.get("/admin/revisions/:id/messages", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "revision id")

  const { data: revision, error: revisionErr } = await supabase
    .from("revisions")
    .select("id, order_id")
    .eq("id", id)
    .single()

  if (revisionErr || !revision) {
    if (revisionErr?.code === "PGRST116") return adminJsonError(res, 404, "Revision not found.")
    return adminHandleSupabaseError(res, revisionErr, "Unable to load revision.")
  }

  const { data: messages, error: messagesErr } = await supabase
    .from("revision_messages")
    .select("*")
    .eq("revision_id", id)
    .order("created_at", { ascending: true })

  if (messagesErr) return adminHandleSupabaseError(res, messagesErr, "Unable to load revision messages.")

  return res.json({ success: true, messages: messages || [] })
}))

app.post("/admin/revisions/:id/messages", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "revision id")

  const senderTypeRaw = req.body?.sender_type
  let senderType = "admin"
  if (senderTypeRaw !== undefined && senderTypeRaw !== null && senderTypeRaw !== "") {
    if (typeof senderTypeRaw !== "string") return adminJsonError(res, 400, "sender_type must be a string.")
    if (!ALLOWED_REVISION_MESSAGE_SENDERS.has(senderTypeRaw)) {
      return adminJsonError(res, 400, "Invalid sender_type.")
    }
    senderType = senderTypeRaw
  }

  const message = adminStringOrNull(req.body?.message, "message", 6000)
  if (!message) return adminJsonError(res, 400, "message is required.")

  let attachments = []
  if (adminHasOwn(req.body, "attachments")) {
    if (req.body.attachments === null || req.body.attachments === undefined) {
      attachments = []
    } else if (Array.isArray(req.body.attachments)) {
      attachments = req.body.attachments
    } else {
      return adminJsonError(res, 400, "attachments must be an array.")
    }
  }

  const { data: revision, error: revisionErr } = await supabase
    .from("revisions")
    .select("id, order_id")
    .eq("id", id)
    .single()

  if (revisionErr || !revision) {
    if (revisionErr?.code === "PGRST116") return adminJsonError(res, 404, "Revision not found.")
    return adminHandleSupabaseError(res, revisionErr, "Unable to load revision.")
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("revision_messages")
    .insert({
      revision_id: revision.id,
      order_id: revision.order_id,
      sender_type: senderType,
      message,
      attachments,
    })
    .select("*")
    .single()

  if (insertErr || !inserted) {
    return adminHandleSupabaseError(res, insertErr, "Unable to send message.")
  }

  return res.json({ success: true, message: inserted })
}))


app.get("/admin/orders/:id/revision-chat-messages", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "order id")

  const { data: messages, error } = await supabase
    .from("revision_chat_messages")
    .select("*")
    .eq("order_id", id)
    .order("created_at", { ascending: true })

  if (error) return adminHandleSupabaseError(res, error, "Unable to load chat messages.")

  await supabase
    .from("revision_chat_messages")
    .update({ is_read_by_admin: true })
    .eq("order_id", id)
    .eq("sender_type", "customer")
    .eq("is_read_by_admin", false)

  const signedMessages = await withSignedChatMessages(messages || [])

  return res.json({ success: true, messages: signedMessages })
}))

app.post(
  "/admin/orders/:id/revision-chat-message",
  requireAdmin,
  chatImageUpload.array("images", CHAT_IMAGE_MAX_PER_MESSAGE),
  adminAsync(async (req, res) => {
    const id = adminRequireUuid(req.params.id, "order id")

    const cleanMessage = normalizeText(req.body?.message, 4000)
    const files = Array.isArray(req.files) ? req.files : []

    if (!cleanMessage && files.length === 0) {
      return adminJsonError(res, 400, "Message text or images required.")
    }

    if (files.length > CHAT_IMAGE_MAX_PER_MESSAGE) {
      return adminJsonError(res, 400, `Max ${CHAT_IMAGE_MAX_PER_MESSAGE} images per message.`)
    }

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, razorpay_order_id, name, email")
      .eq("id", id)
      .single()

    if (orderErr || !order) {
      if (orderErr?.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
      return adminHandleSupabaseError(res, orderErr, "Unable to load order.")
    }

    const uploadedAttachments = []
    for (const file of files) {
      const path = await uploadRevisionChatImage(id, file)
      uploadedAttachments.push({
        path,
        file_name: file.originalname || basenameFromPath(path),
      })
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("revision_chat_messages")
      .insert({
        order_id: id,
        sender_type: "admin",
        sender_name: req.admin?.email || "SoulScript Team",
        message: cleanMessage || null,
        attachments: uploadedAttachments,
        is_read_by_admin: true,
        is_read_by_customer: false,
      })
      .select("*")
      .single()

    if (insertErr) {
      return adminHandleSupabaseError(res, insertErr, "Could not send message.")
    }

    if (order.email) {
      const portalUrl = `${PORTAL_BASE_URL}/story?order=${encodeURIComponent(order.razorpay_order_id || "")}`
      await sendEmailSafe({
        to: order.email,
        subject: "New message about your novel",
        html: brandedEmailTemplate({
          title: "You have a new message",
          bodyHtml:
            emailParagraph(`Dear ${escapeHtml(order.name || "")},`) +
            emailParagraph("Our team has sent you a new message about your novel review. Please check your story portal to view and reply.") +
            (cleanMessage ? emailDivider() + emailMuted(nl2br(cleanMessage)) : ""),
          ctaLabel: "Open Story Portal",
          ctaUrl: portalUrl,
        }),
      })
    }

    const signed = (await withSignedChatMessages([inserted]))[0]
    return res.json({ success: true, message: signed })
  })
)

/* =========================
   ADMIN: REVENUE
========================= */
app.get("/admin/revenue", requireAdmin, adminAsync(async (req, res) => {
  const [ordersResult, addonsResult] = await Promise.all([
    supabase
      .from("orders")
      .select(ADMIN_ORDER_LIST_FIELDS)
      .order("created_at", { ascending: false }),
    supabase.from("order_addons").select("*"),
  ])

  if (ordersResult.error) return adminHandleSupabaseError(res, ordersResult.error, "Unable to load revenue orders.")
  if (addonsResult.error) return adminHandleSupabaseError(res, addonsResult.error, "Unable to load revenue add-ons.")

  const orders = ordersResult.data || []
  const addons = addonsResult.data || []

  const now = new Date()
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth()

  let totalCollected = 0
  let thisMonthCollected = 0
  let totalPendingBalance = 0
  let totalOrders = 0
  let prepaidOrders = 0
  let advanceOrders = 0
  let totalOrderValueSum = 0

  for (const order of orders) {
    totalOrders += 1

    const paid = Number(order.paid_amount || order.amount || 0)
    const safePaid = Number.isFinite(paid) ? paid : 0
    totalCollected += safePaid

    if (order.created_at) {
      const created = new Date(order.created_at)
      if (
        !Number.isNaN(created.getTime()) &&
        created.getUTCFullYear() === currentYear &&
        created.getUTCMonth() === currentMonth
      ) {
        thisMonthCollected += safePaid
      }
    }

    const pending = Number(order.balance_due || order.pending_amount || 0)
    if (Number.isFinite(pending)) totalPendingBalance += pending

    const orderValue = Number(order.total_order_value || order.amount || 0)
    if (Number.isFinite(orderValue)) totalOrderValueSum += orderValue

    if (order.payment_type === "PREPAID") prepaidOrders += 1
    else if (order.payment_type === "ADVANCE") advanceOrders += 1
  }

  const addonRevenue = addons
    .filter(addonIsPaid)
    .reduce((sum, addon) => sum + addonAmount(addon), 0)

  return res.json({
    success: true,
    summary: {
      total_collected: totalCollected,
      this_month_collected: thisMonthCollected,
      total_pending_balance: totalPendingBalance,
      total_orders: totalOrders,
      prepaid_orders: prepaidOrders,
      advance_orders: advanceOrders,
      addon_revenue: addonRevenue,
      total_order_value: totalOrderValueSum,
    },
    orders,
  })
}))

app.get("/admin/story-intakes", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("story_intakes").select("*").order("updated_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load story intakes.")
  return res.json({ success: true, story_intakes: data || [] })
}))

app.get("/admin/voice-notes", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("voice_notes").select("*").order("created_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load voice notes.")
  return res.json({ success: true, voice_notes: await withSignedVoiceNotes(data || []) })
}))

app.get("/admin/call-bookings", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("call_bookings").select("*").order("created_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load call bookings.")
  return res.json({ success: true, call_bookings: data || [] })
}))

app.get("/admin/deliverables", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("deliverables").select("*").order("uploaded_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load deliverables.")
  return res.json({ success: true, deliverables: await withSignedDeliverables(data || []) })
}))

app.get("/admin/revisions", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("revisions").select("*").order("created_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load revisions.")
  return res.json({ success: true, revisions: data || [] })
}))

app.get("/admin/addons", requireAdmin, adminAsync(async (req, res) => {
  const { data, error } = await supabase.from("order_addons").select("*").order("created_at", { ascending: false })
  if (error) return adminHandleSupabaseError(res, error, "Unable to load add-ons.")
  return res.json({ success: true, addons: data || [] })
}))

app.get("/admin/ultra-priority", requireAdmin, adminAsync(async (req, res) => {
  const [ordersResult, addonsResult] = await Promise.all([
    supabase.from("orders").select(ADMIN_ORDER_LIST_FIELDS).order("created_at", { ascending: false }),
    supabase.from("order_addons").select("*").order("created_at", { ascending: false }),
  ])

  if (ordersResult.error) return adminHandleSupabaseError(res, ordersResult.error, "Unable to load ultra priority orders.")
  if (addonsResult.error) return adminHandleSupabaseError(res, addonsResult.error, "Unable to load ultra priority add-ons.")

  const orders = ordersResult.data || []
  const addons = addonsResult.data || []

  const ultraOrderIds = new Set(
    addons.filter(addonLooksUltraPriority).map((addon) => addon.order_id)
  )

  const ultraOrders = orders.filter((order) => {
    return (
      ultraOrderIds.has(order.id) ||
      containsUltraPriority(order.production_status) ||
      containsUltraPriority(order.order_status)
    )
  })

  return res.json({
    success: true,
    orders: ultraOrders,
    addons,
  })
}))

app.patch("/admin/revisions/:id", requireAdmin, adminAsync(async (req, res) => {
  const id = adminRequireUuid(req.params.id, "revision id")
  const updates = {}

  if (adminHasOwn(req.body, "status")) updates.status = adminRevisionStatus(req.body.status)
  if (adminHasOwn(req.body, "paid")) updates.paid = adminBoolean(req.body.paid, "paid")
  if (adminHasOwn(req.body, "is_free")) updates.is_free = adminBoolean(req.body.is_free, "is_free")
  if (adminHasOwn(req.body, "charge")) updates.charge = adminNumberOrNull(req.body.charge, "charge")
  if (adminHasOwn(req.body, "razorpay_order_id")) updates.razorpay_order_id = adminStringOrNull(req.body.razorpay_order_id, "razorpay_order_id", 120)

  if (Object.keys(updates).length === 0) return adminJsonError(res, 400, "No allowed revision fields provided.")

  const { data, error } = await supabase.from("revisions").update(updates).eq("id", id).select("*").single()
  if (error) {
    if (error.code === "PGRST116") return adminJsonError(res, 404, "Revision not found.")
    return adminHandleSupabaseError(res, error, "Unable to update revision.")
  }

  return res.json({ success: true, revision: data })
}))

/* Legacy path-based fallback. Chandan UI should use /admin/orders/:id/upload-review-files. */
app.post("/admin/deliverables", requireAdmin, adminAsync(async (req, res) => {
  const orderId = adminRequireUuid(req.body.order_id, "order_id")
  const pdfPath = adminStringOrNull(req.body.pdf_path, "pdf_path", 1200)
  const coverPath = adminStringOrNull(req.body.cover_path, "cover_path", 1200)

  if (!pdfPath && !coverPath) return adminJsonError(res, 400, "PDF path or cover path is required.")

  const now = new Date().toISOString()
  const versionNumber = await getNextReviewVersion(orderId)

  const { data: reviewFile, error: reviewFileErr } = await supabase
    .from("review_files")
    .insert({
      order_id: orderId,
      version_number: versionNumber,
      manuscript_pdf_path: pdfPath,
      cover_file_path: coverPath,
      status: "sent_for_review",
      sent_for_review_at: now,
    })
    .select("*")
    .single()

  if (reviewFileErr) {
    console.error("Unable to create review file.", reviewFileErr)
  }

  const { data, error } = await supabase
    .from("deliverables")
    .insert({
      order_id: orderId,
      pdf_path: pdfPath,
      cover_path: coverPath,
      uploaded_at: now,
      review_file_id: reviewFile?.id || null,
      status: "waiting_customer_review",
    })
    .select("*")
    .single()

  if (error) return adminHandleSupabaseError(res, error, "Unable to create deliverable.")

  await supabase
    .from("orders")
    .update({
      production_status: "review_ready",
      order_status: "review_ready",
      latest_review_file_id: reviewFile?.id || null,
    })
    .eq("id", orderId)

  const { data: order } = await supabase.from("orders").select("*").eq("id", orderId).single()

  if (order?.email) {
    await sendEmailSafe({
      to: order.email,
      subject: "Your review files are ready",
      html: brandedEmailTemplate({
        title: "Your review files are ready",
        bodyHtml:
          emailParagraph(`Dear ${escapeHtml(order.name)},`) +
          emailParagraph("Your manuscript and cover review files are now available in your story portal.") +
          emailParagraph("Please review them carefully. You can approve them for printing or request changes from the portal."),
        ctaLabel: "Open Review Portal",
        ctaUrl: `${PORTAL_BASE_URL}/story?order=${encodeURIComponent(order.razorpay_order_id)}`,
      }),
    })
  }

  return res.json({
    success: true,
    deliverable: (await withSignedDeliverables([data]))[0],
    review_file: reviewFile ? (await withSignedReviewFiles([reviewFile]))[0] : null,
  })
}))

app.post("/admin/orders/:id/delhivery-create-shipment", requireAdmin, adminAsync(async (req, res) => {
    const id = adminRequireUuid(req.params.id, "order id")

    const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("*")
        .eq("id", id)
        .single()

    if (orderErr || !order) {
        if (orderErr?.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
        return adminHandleSupabaseError(res, orderErr, "Unable to load order.")
    }

    if (order.awb_number) {
        return adminJsonError(res, 409, "Shipment already created for this order. AWB: " + order.awb_number)
    }

    let shipmentResponse
    try {
        const payload = buildDelhiveryShipmentPayload(order)
        const formData = `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`

        shipmentResponse = await delhiveryRequest("/api/cmu/create.json", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formData,
        })
    } catch (err) {
        if (typeof Sentry !== "undefined" && process.env.SENTRY_DSN) {
            Sentry.captureException(err, { tags: { endpoint: "delhivery-create-shipment" } })
        }
        console.error("Delhivery shipment creation failed:", safeErr(err))
        return adminJsonError(res, 502, err?.message || "Delhivery API error")
    }

    const packages = shipmentResponse?.packages || []
    const firstPackage = packages[0] || {}
    const success = firstPackage.status === "Success" || shipmentResponse?.success === true

    if (!success) {
        const remark = firstPackage.remarks?.join(", ") || shipmentResponse?.rmk || "Unknown error"
        return adminJsonError(res, 502, `Delhivery rejected shipment: ${remark}`)
    }

    const awb = firstPackage.waybill || ""
    if (!awb) {
        return adminJsonError(res, 502, "Delhivery did not return a waybill number")
    }

    const labelUrl = `${DELHIVERY_BASE_URL}/api/p/packing_slip?wbns=${awb}&pdf=true`

    const updates = {
        awb_number: awb,
        tracking_number: awb,
        shipment_status: "in_transit",
        production_status: "in_transit",
        order_status: "in_transit",
        shipping_label_url: labelUrl,
    }

    const { data: updatedOrder, error: updateErr } = await supabase
        .from("orders")
        .update(updates)
        .eq("id", id)
        .select("*")
        .single()

    if (updateErr) {
        console.error("Order update after Delhivery success failed:", updateErr)
    }

    if (order.email) {
        const trackingUrl = `https://www.delhivery.com/track/package/${awb}`
        await sendEmailSafe({
            to: order.email,
            subject: "Your SoulScript Legacy book has been dispatched",
            html: brandedEmailTemplate({
                title: "Your book is on the way",
                bodyHtml:
                    emailParagraph(`Dear ${escapeHtml(order.name || "")},`) +
                    emailParagraph("Your personalized novel has been dispatched and is on its way to you.") +
                    emailDetails([
                        { label: "Tracking number", value: awb },
                        { label: "Courier", value: "Delhivery" },
                    ]),
                ctaLabel: "Track Shipment",
                ctaUrl: trackingUrl,
            }),
        })
    }

    return res.json({
        success: true,
        awb,
        labelUrl,
        order: updatedOrder || null,
        delhiveryResponse: shipmentResponse,
    })
}))

app.get("/admin/orders/:id/delhivery-label", requireAdmin, adminAsync(async (req, res) => {
    const id = adminRequireUuid(req.params.id, "order id")

    const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("id, awb_number, tracking_number")
        .eq("id", id)
        .single()

    if (orderErr || !order) {
        if (orderErr?.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
        return adminHandleSupabaseError(res, orderErr, "Unable to load order.")
    }

    const awb = order.awb_number || order.tracking_number
    if (!awb) {
        return adminJsonError(res, 400, "No AWB number on this order")
    }

    if (!DELHIVERY_API_TOKEN) {
        return adminJsonError(res, 500, "Delhivery is not configured")
    }

    try {
        const url = `${DELHIVERY_BASE_URL}/api/p/packing_slip?wbns=${encodeURIComponent(awb)}&pdf=true`
        const response = await fetch(url, {
            method: "GET",
            headers: {
                "Authorization": `Token ${DELHIVERY_API_TOKEN}`,
                "Accept": "application/pdf",
            },
        })

        if (!response.ok) {
            const errorText = await response.text().catch(() => "")
            console.error("Delhivery label fetch failed:", {
                status: response.status,
                error: errorText.slice(0, 500),
            })
            return adminJsonError(res, 502, "Could not fetch Delhivery label")
        }

        res.setHeader("Content-Type", "application/pdf")
        res.setHeader("Content-Disposition", `attachment; filename="SoulScript-label-${awb}.pdf"`)

        if (response.body && typeof Readable.fromWeb === "function") {
            return Readable.fromWeb(response.body).pipe(res)
        }

        const arrayBuffer = await response.arrayBuffer()
        return res.send(Buffer.from(arrayBuffer))
    } catch (err) {
        console.error("Delhivery label download failed:", safeErr(err))
        return adminJsonError(res, 502, err?.message || "Delhivery label download error")
    }
}))

app.get("/admin/orders/:id/delhivery-tracking", requireAdmin, adminAsync(async (req, res) => {
    const id = adminRequireUuid(req.params.id, "order id")

    const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("id, name, email, awb_number, tracking_number, shipment_status")
        .eq("id", id)
        .single()

    if (orderErr || !order) {
        if (orderErr?.code === "PGRST116") return adminJsonError(res, 404, "Order not found.")
        return adminHandleSupabaseError(res, orderErr, "Unable to load order.")
    }

    const awb = order.awb_number || order.tracking_number
    if (!awb) {
        return adminJsonError(res, 400, "No AWB number on this order")
    }

    try {
        const tracking = await delhiveryRequest(`/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`, {
            method: "GET",
        })

        const shipment = tracking?.ShipmentData?.[0]?.Shipment || null
        const status = shipment?.Status?.Status || ""
        const statusLower = String(status).toLowerCase()
        let mappedStatus = null

        if (statusLower.includes("delivered")) {
            mappedStatus = "delivered"
        } else if (
            statusLower.includes("transit") ||
            statusLower.includes("dispatched") ||
            statusLower.includes("manifested") ||
            statusLower.includes("shipped")
        ) {
            mappedStatus = "in_transit"
        }

        let updatedOrder = order

        if (mappedStatus) {
            const updates = {
                shipment_status: mappedStatus,
                production_status: mappedStatus,
                order_status: mappedStatus,
            }

            const { data, error: updateErr } = await supabase
                .from("orders")
                .update(updates)
                .eq("id", id)
                .select("*")
                .single()

            if (updateErr) {
                console.error("Order update after Delhivery tracking failed:", updateErr)
                return adminHandleSupabaseError(res, updateErr, "Unable to update tracking status.")
            }

            updatedOrder = data || order

            if (mappedStatus === "delivered" && order.shipment_status !== "delivered" && order.email) {
                await sendEmailSafe({
                    to: order.email,
                    subject: "Your SoulScript Legacy book has been delivered",
                    html: brandedEmailTemplate({
                        title: "Your book has arrived",
                        bodyHtml:
                            emailParagraph(`Dear ${escapeHtml(order.name || "")},`) +
                            emailParagraph("Your personalized novel has been delivered. We hope you cherish every page."),
                    }),
                })
            }
        }

        return res.json({
            success: true,
            awb,
            status,
            mappedStatus,
            order: updatedOrder,
            tracking,
        })
    } catch (err) {
        console.error("Delhivery tracking failed:", safeErr(err))
        return adminJsonError(res, 502, err?.message || "Delhivery tracking error")
    }
}))
/* =========================
   DELHIVERY WEBHOOKS
========================= */
app.post("/webhooks/delhivery-status", async (req, res) => {
    try {
        const payload = req.body || {}
        console.log("Delhivery webhook received:", JSON.stringify(payload).slice(0, 500))

        const awb = payload?.Shipment?.AWB || payload?.waybill || payload?.awb
        const status = payload?.Shipment?.Status?.Status || payload?.status || ""

        if (!awb) {
            return res.status(400).json({ error: "Missing AWB" })
        }

        const { data: order } = await supabase
            .from("orders")
            .select("id, name, email, razorpay_order_id, shipment_status")
            .eq("awb_number", awb)
            .single()

        if (!order) {
            console.warn("Delhivery webhook: no order found for AWB:", awb)
            return res.json({ ok: true, ignored: true })
        }

        const statusLower = String(status).toLowerCase()
        let newStatus = order.shipment_status

        if (statusLower.includes("delivered")) {
            newStatus = "delivered"
        } else if (statusLower.includes("transit") || statusLower.includes("dispatched") || statusLower.includes("manifested") || statusLower.includes("shipped")) {
            newStatus = "in_transit"
        }

        if (newStatus !== order.shipment_status) {
            const updates = { shipment_status: newStatus }
            if (newStatus === "delivered") {
                updates.production_status = "delivered"
                updates.order_status = "delivered"
            }

            await supabase.from("orders").update(updates).eq("id", order.id)

            if (newStatus === "delivered" && order.email) {
                await sendEmailSafe({
                    to: order.email,
                    subject: "Your SoulScript Legacy book has been delivered",
                    html: brandedEmailTemplate({
                        title: "Your book has arrived",
                        bodyHtml:
                            emailParagraph(`Dear ${escapeHtml(order.name || "")},`) +
                            emailParagraph("Your personalized novel has been delivered. We hope you cherish every page."),
                    }),
                })
            }
        }

        return res.json({ ok: true, awb, newStatus })
    } catch (err) {
        console.error("/webhooks/delhivery-status error:", safeErr(err))
        return res.status(500).json({ error: "Webhook handler failed" })
    }
})

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`)
  console.log(`✅ RAZORPAY MODE = ${RAZORPAY_MODE.toUpperCase()}`)
  console.log(`✅ RATE LIMITING = Enabled on auth + portal endpoints`)
  console.log(`✅ SENTRY = ${process.env.SENTRY_DSN ? "Enabled" : "Disabled"}`)
  console.log(`✅ PORTAL_BASE_URL = ${PORTAL_BASE_URL}`)
  console.log(`✅ EMAIL_FROM      = ${EMAIL_FROM}`)
  console.log(`✅ ADMIN_EMAIL     = ${ADMIN_EMAIL}`)
  console.log(`✅ ACCOUNT LOGIN   = Email OTP`)
  console.log(`✅ ADMIN API       = Enabled`)
  console.log(`✅ STORY API       = Enabled`)
  console.log(`✅ DELHIVERY = ${DELHIVERY_API_TOKEN ? "Configured" : "NOT CONFIGURED"}`)
  console.log(`✅ STORAGE API     = Signed URLs enabled`)
  console.log(`✅ PRINT/SHIPMENT/PAYOUT/REVIEW-CHAT/REVENUE = Enabled`)
  console.log(`✅ PHASE 1 DOWNLOADS = story.txt, voice-notes.zip, cover-material.zip`)
  console.log(`✅ PHASE 2 = Balance gate, cart payments, review chat, white labeling`)
  console.log(`✅ PHASE 3 = Extra writing flow + Delhivery (incoming)`)
})
