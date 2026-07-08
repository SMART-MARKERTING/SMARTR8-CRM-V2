import dotenv from "dotenv";

dotenv.config();

function env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

const DEFAULT_EMAIL_FROM = "MDESHAZO@mykoal.com";
const DEFAULT_EMAIL_ALIASES = "MDESHAZO@mykoal.com,info@mykoal.com";

function replaceRetiredSender(value: string, fallback = DEFAULT_EMAIL_FROM): string {
  return /mike@adaxahomeloans\.com|hello@mykoal\.com|noreply@mykoal\.com/i.test(value) ? fallback : value;
}

export const config = {
  port: parseInt(env("PORT", "3000"), 10),
  tokenDir: env("TOKEN_DIR", ".tokens"),
  // Absolute base URL for hosted MMS media (e.g. https://smartr8-texting-1wx7.onrender.com).
  // Optional: when unset we derive it from the incoming request host.
  publicBaseUrl: env("PUBLIC_BASE_URL", "").replace(/\/+$/, ""),

  // Outbound text routing. "auto" (default): iMessage-first, then fall back to Telnyx SMS
  // when iMessage doesn't deliver (BlueBubbles unreachable / failed send). "sms": always
  // Telnyx SMS. "imessage": always iMessage. The console's "Outbound texting channel" toggle
  // (stored in DB) overrides this at runtime, no redeploy needed.
  messagingMode: env("MESSAGING_MODE", "auto").toLowerCase(),

  // "Resend quote" targets: the website Quick-Quote email endpoint, and the options
  // page linked in the follow-up text. Overridable via env.
  quoteSendUrl: env("QUOTE_SEND_URL", "https://smartr8.com/api/quote/send"),
  optionsLinkUrl: env("QUOTE_OPTIONS_URL", "https://smartr8.com/see-my-options"),

  // Render platform (auto-set by Render) — lets the service report/trigger its own deploy.
  render: {
    gitCommit: env("RENDER_GIT_COMMIT"),
    serviceId: env("RENDER_SERVICE_ID"),
    apiToken: env("RENDER_API_TOKEN"),
  },

  ghl: {
    apiBase: "https://services.leadconnectorhq.com",
    oauthBase: "https://marketplace.gohighlevel.com",
    locationId: env("GHL_LOCATION_ID"),
    apiVersion: env("GHL_API_VERSION", "2021-04-15"),
    searchApiVersion: env("GHL_SEARCH_API_VERSION", "2023-02-21"),
    clientId: env("GHL_CLIENT_ID"),
    clientSecret: env("GHL_CLIENT_SECRET"),
    redirectUri: env("GHL_REDIRECT_URI"),
    conversationProviderId: env("GHL_CONVERSATION_PROVIDER_ID"),
    // Logging phone CALLS to GHL needs a provider whose type is "Call" — the SMS
    // provider above is rejected for type "Call" ("Incorrect conversationProviderId/type").
    // Create a second conversation provider (Type: Call) in GHL and put its id here.
    callConversationProviderId: env("GHL_CALL_CONVERSATION_PROVIDER_ID"),
    pit: env("GHL_PIT"),
    scopes: [
      "contacts.readonly",
      "contacts.write",
      "conversations.readonly",
      "conversations.write",
      "conversations/message.readonly",
      "conversations/message.write",
    ],
  },

  telnyx: {
    apiBase: "https://api.telnyx.com",
    apiKey: env("TELNYX_API_KEY"),
    fromNumber: env("TELNYX_FROM_NUMBER"),
    messagingProfileId: env("TELNYX_MESSAGING_PROFILE_ID"),
    // Extra sending numbers for the dialer selector + smart call routing (E.164,
    // comma-separated). The primary FROM number is always included automatically.
    numbers: env("TELNYX_NUMBERS"),
  },

  whatsapp: {
    twilioAccountSid: env("TWILIO_ACCOUNT_SID"),
    twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
    twilioFrom: env("TWILIO_WHATSAPP_FROM"),
    accessToken: env("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"),
    verifyToken: env("WHATSAPP_VERIFY_TOKEN"),
    appSecret: env("WHATSAPP_APP_SECRET"),
    graphVersion: env("WHATSAPP_GRAPH_VERSION", "v21.0"),
    aiAutoSendEnabled: env("WHATSAPP_AI_AUTOSEND_ENABLED", "false") === "true",
  },

  bluebubbles: {
    url: env("BLUEBUBBLES_URL").replace(/\/+$/, ""),
    password: env("BLUEBUBBLES_PASSWORD"),
  },

  // Net-new Cloudflare texting + MCP Worker (Cowork connector). To keep Cowork's
  // threads in sync WITHOUT repointing Telnyx away from this service, we relay a
  // copy of each inbound here (best-effort, fire-and-forget). Unset = disabled.
  // Include any ?key=WEBHOOK_SECRET the Worker expects, e.g.
  //   https://smartr8-texting-crm.<sub>.workers.dev/webhooks/telnyx?key=SECRET
  textingMcp: {
    telnyxUrl: env("TEXTING_MCP_TELNYX_URL"),
    bluebubblesUrl: env("TEXTING_MCP_BLUEBUBBLES_URL"),
  },

  routing: {
    imessageTag: env("IMESSAGE_TAG", "imessage"),
    defaultCountryCode: env("DEFAULT_COUNTRY_CODE", "+1"),
  },

  // Telnyx Voice (calling)
  voice: {
    applicationId: env("TELNYX_VOICE_APP_ID", env("TELNYX_CONNECTION_ID")), // Voice API Application = connection_id
    myCell: env("MY_CELL_NUMBER", "+16232808351"), // bridge/forward target (E.164); inbound app-then-cell fallback
    callNowTag: env("CALL_NOW_TAG", "call-now"), // tag a contact with this to trigger a dial
    pollMs: parseInt(env("CALL_POLL_MS", "20000"), 10), // call-now poll interval
    amdMode: env("TELNYX_AMD_MODE", "greeting_end"), // waits for voicemail greeting/beep before playback
  },

  // Browser softphone (Telnyx WebRTC)
  webrtc: {
    sipConnectionId: env("TELNYX_SIP_CONNECTION_ID"), // Telnyx SIP Connection (Credentials type)
    callerNumber: env("TELNYX_FROM_NUMBER"), // caller ID shown on softphone calls
  },

  // Inbound call routing
  inbound: {
    // "app-then-cell" (default) = ring the WebRTC portal first, then fall back to your cell.
    // "ivr" = legacy (answer → press 1 forward to cell / 9 opt-out).
    mode: env("INBOUND_MODE", "app-then-cell"),
    appRingSecs: parseInt(env("INBOUND_APP_RING_SECS", "30"), 10), // ~5 rings on the CRM before forwarding
    cellRingSecs: parseInt(env("INBOUND_CELL_RING_SECS", "30"), 10), // ~5 rings on the cell before giving up
    // Business-hours forwarding window: during it, an unanswered portal ring forwards to the
    // cell; outside it, calls go straight to the cell. A console toggle can disable forwarding
    // entirely (portal-only). Times are whole hours in FORWARD_TZ; FORWARD_DAYS = 1=Mon..7=Sun.
    forwardTz: env("FORWARD_TZ", "America/Phoenix"),
    forwardStart: parseInt(env("FORWARD_HOURS_START", "9"), 10),
    forwardEnd: parseInt(env("FORWARD_HOURS_END", "17"), 10),
    forwardDays: env("FORWARD_DAYS", "1,2,3,4,5"),
  },

  // Web app (softphone UI) access gate
  app: {
    passcode: env("APP_PASSCODE"), // required to mint a softphone token / dial
  },

  // GHL custom workflow action (Marketplace "Workflow Action"): shared secret that
  // must be present in the action's webhook URL (?key=…) so only GHL can trigger it.
  workflow: {
    actionSecret: env("GHL_ACTION_SECRET"),
  },

  // Calling compliance guardrails (hard gates)
  compliance: {
    consentTag: env("CALL_CONSENT_TAG", "call_consent"),
    callHoursStart: parseInt(env("CALL_HOURS_START", "8"), 10),
    callHoursEnd: parseInt(env("CALL_HOURS_END", "21"), 10),
    throttleMs: parseInt(env("CALL_THROTTLE_MS", "60000"), 10),
  },

  // Self-contained CRM (leads, notes, activity, automations) — SQLite on the disk.
  crm: {
    // SQLite DB file (lives on the same persistent disk as the OAuth tokens / DNC list).
    dbFile: env("CRM_DB_FILE", "crm.db"),
    // Public website lead-intake webhook secret (?key=… on POST /webhooks/lead).
    leadWebhookSecret: env("LEAD_WEBHOOK_SECRET"),
    // How often (ms) the automation worker wakes to run due steps.
    automationPollMs: parseInt(env("AUTOMATION_POLL_MS", "15000"), 10),
    // Default IANA timezone for leads with no timezone (used by the calling-hours gate
    // for voicemail drops). Empty → voicemail steps for tz-less leads run immediately.
    defaultTimezone: env("CRM_DEFAULT_TIMEZONE", ""),
    // Mirror leads/notes/activity into GHL as well (best-effort). Off by default since
    // the local DB is now the system of record.
    mirrorToGhl: env("CRM_MIRROR_TO_GHL", "false") === "true",
    // One-way legacy CRM sync receiver. The old crm.smartr8.com app posts lead snapshots
    // here so /v2 stays live while both apps run side-by-side. Prefer a dedicated secret;
    // LEAD_WEBHOOK_SECRET is a fallback so existing Render envs can be wired quickly.
    legacySyncSecret: env("CRM_V2_SYNC_SECRET", env("CRM_SYNC_SECRET", env("LEAD_WEBHOOK_SECRET"))),
    // Public origin of this service (e.g. https://smartr8-texting-1wx7.onrender.com),
    // used to build email unsubscribe links + List-Unsubscribe headers. Falls back
    // to the OAuth redirect URI's origin when unset.
    publicBaseUrl: env("PUBLIC_BASE_URL", ""),
  },

  borrowerData: {
    // Required before full SSNs, DOB, income, assets, or other borrower financial data
    // can be stored. Use a long random secret; rotate by migrating/re-encrypting rows.
    encryptionKey: env("BORROWER_DATA_KEY"),
    retentionDays: parseInt(env("BORROWER_DATA_RETENTION_DAYS", "2555"), 10),
  },

  // Email sending (Resend) — used by the new-lead automation's email step.
  email: {
    resendApiKey: env("RESEND_API_KEY"),
    fromEmail: replaceRetiredSender(env("EMAIL_FROM", DEFAULT_EMAIL_FROM)),
    fromAliases: env("EMAIL_FROM_ALIASES", DEFAULT_EMAIL_ALIASES),
    replyTo: replaceRetiredSender(env("EMAIL_REPLY_TO", DEFAULT_EMAIL_FROM)),
    resendWebhookSecret: env("RESEND_WEBHOOK_SECRET"),
  },

  // LOS / settlement / credit vendor integrations. These are intentionally optional:
  // the UI can prepare and audit orders, but real pulls/orders must remain disabled until
  // credentials, permissible-purpose controls, and vendor contracts are configured.
  loanServices: {
    xactusApiBase: env("XACTUS_API_BASE").replace(/\/+$/, ""),
    xactusApiKey: env("XACTUS_API_KEY"),
    titleApiBase: env("TITLE_API_BASE").replace(/\/+$/, ""),
    titleApiKey: env("TITLE_API_KEY"),
    floodApiBase: env("FLOOD_API_BASE").replace(/\/+$/, ""),
    floodApiKey: env("FLOOD_API_KEY"),
  },

  // Voicemail drop (Telnyx Answering Machine Detection → play a pre-recorded message).
  voicemail: {
    // Public URL to the pre-recorded voicemail audio (mp3/wav). Required for drops.
    audioUrl: env("VOICEMAIL_AUDIO_URL"),
  },

  // ElevenLabs text-to-speech for generated voicemail-drop recordings. Admin settings
  // stored in SQLite override these env defaults.
  elevenLabs: {
    apiKey: env("ELEVENLABS_API_KEY"),
    voiceId: env("ELEVENLABS_VOICE_ID"),
    modelId: env("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2"),
    outputFormat: env("ELEVENLABS_OUTPUT_FORMAT", "mp3_44100_128"),
  },

  // Meta Conversions API (server-side ad-conversion events). Fires a "Lead" event to Meta
  // when a new website lead lands, matched to the person by hashed email/phone so Meta can
  // optimize ad delivery toward people who actually become leads. Same dataset (pixel) as the
  // browser pixel on the funnel, so the server event de-dups with the page's PageView via event_id.
  meta: {
    // Meta Pixel / Dataset ID (also the browser pixel ID on the funnel + console).
    pixelId: env("META_PIXEL_ID", "723066527555884"),
    // Conversions API access token (Events Manager → Settings → Generate access token).
    // When unset, CAPI is a no-op (the rest of lead intake is unaffected).
    capiToken: env("META_CAPI_TOKEN"),
    // Graph API version for the events endpoint. Any recent version works; bump as Meta releases.
    graphVersion: env("META_GRAPH_VERSION", "v21.0"),
    // Optional Test Event Code (Events Manager → Test Events) to verify wiring without polluting live data.
    testEventCode: env("META_TEST_EVENT_CODE"),
    // action_source for funnel-origin leads. "website" gives the best attribution (matches the
    // funnel pixel); use "system_generated" for purely backend/CRM-originated leads.
    actionSource: env("META_ACTION_SOURCE", "website"),
    // Fallback event_source_url when the funnel didn't forward the capture page URL.
    defaultEventSourceUrl: env("META_EVENT_SOURCE_URL", "https://smartr8.com"),
  },
};

/** Logs (does not throw) any missing env so the service still boots for /health. */
export function reportMissingConfig(warn: (m: string) => void): void {
  const missing: string[] = [];
  if (!config.telnyx.apiKey) missing.push("TELNYX_API_KEY");
  if (!config.bluebubbles.url) missing.push("BLUEBUBBLES_URL");
  if (!config.voice.applicationId) missing.push("TELNYX_VOICE_APP_ID or TELNYX_CONNECTION_ID");
  if (!config.voice.myCell) missing.push("MY_CELL_NUMBER");
  if (!config.borrowerData.encryptionKey) missing.push("BORROWER_DATA_KEY");
  const twilioAny = Boolean(config.whatsapp.twilioAccountSid || config.whatsapp.twilioAuthToken || config.whatsapp.twilioFrom);
  const twilioReady = Boolean(config.whatsapp.twilioAccountSid && config.whatsapp.twilioAuthToken && config.whatsapp.twilioFrom);
  const metaAny = Boolean(config.whatsapp.accessToken || config.whatsapp.phoneNumberId || config.whatsapp.verifyToken || config.whatsapp.appSecret);
  const metaReady = Boolean(config.whatsapp.accessToken && config.whatsapp.phoneNumberId);
  if ((twilioAny && !twilioReady) || (metaAny && !metaReady)) {
    missing.push("complete WhatsApp provider vars (Twilio or Meta)");
  }
  if (missing.length) warn(`missing env (set these in .env / host config): ${missing.join(", ")}`);
}
