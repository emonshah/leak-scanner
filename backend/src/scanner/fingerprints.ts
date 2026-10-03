/**
 * Curated fingerprint database. Every entry needs a SUFFICIENT marker set —
 * identity requires enough evidence to avoid false platform names.
 * Unknown slugs are reported as unknown, never guessed.
 *
 * NOTE: the old per-plugin (WP_PLUGINS) inventory was removed. This scanner
 * detects WHAT a site is built with, not plugin lists — path-string matching
 * misfired on non-WordPress sites.
 */

export interface TechPrint {
  id: string;
  name: string;
  category: string;
  markers: { source: 'header' | 'html' | 'asset' | 'cookie' | 'dom'; pattern: RegExp }[];
  strong: boolean;
}

const H = (pattern: RegExp) => ({ source: 'header' as const, pattern });
const M = (pattern: RegExp) => ({ source: 'html' as const, pattern });
const A = (pattern: RegExp) => ({ source: 'asset' as const, pattern });
const C = (pattern: RegExp) => ({ source: 'cookie' as const, pattern });
const D = (pattern: RegExp) => ({ source: 'dom' as const, pattern });

export const TECH_PRINTS: TechPrint[] = [
  // CMS
  { id: 'wordpress', name: 'WordPress', category: 'CMS', strong: true, markers: [
    A(/\/wp-content\//), A(/\/wp-includes\//), M(/<meta[^>]+generator[^>]+wordpress/i),
    M(/wp-embed\.min\.js|wp-block-library/i), C(/wordpress_|wp-settings/i),
  ] },
  { id: 'shopify', name: 'Shopify', category: 'CMS', strong: true, markers: [
    A(/cdn\.shopify\.com/i), M(/myshopify\.com/i), M(/Shopify\.theme/i), H(/x-shopid/i),
  ] },
  { id: 'wix', name: 'Wix', category: 'CMS', strong: true, markers: [
    A(/wixstatic\.com|parastorage\.com/i), M(/wix\.com\/match\/viewer/i), M(/wixEmbedsAPI/i),
  ] },
  { id: 'squarespace', name: 'Squarespace', category: 'CMS', strong: true, markers: [
    A(/static1\.squarespace\.com/i), M(/squarespace/i),
  ] },
  { id: 'webflow', name: 'Webflow', category: 'CMS', strong: true, markers: [
    A(/webflow\.(js|css)/i), M(/data-wf-|webflow/i),
  ] },
  { id: 'drupal', name: 'Drupal', category: 'CMS', strong: true, markers: [
    A(/sites\/default\/files/i), A(/drupal\.js/i), M(/Drupal\.settings/i),
  ] },
  { id: 'joomla', name: 'Joomla', category: 'CMS', strong: true, markers: [
    A(/\/media\/jui\//i), M(/joomla/i), M(/<meta[^>]+generator[^>]+joomla/i),
  ] },
  { id: 'ghost', name: 'Ghost', category: 'CMS', strong: true, markers: [
    A(/ghost-sdk|ghost\.min\.js/i), M(/ghost-head|ghost-foot/i),
  ] },
  { id: 'hubspot', name: 'HubSpot CMS', category: 'CMS', strong: true, markers: [
    A(/hs-scripts\.com|hsforms\.net/i),
  ] },
  // Frameworks
  { id: 'laravel', name: 'Laravel', category: 'Framework', strong: true, markers: [
    C(/laravel_session|XSRF-TOKEN/i), M(/<meta[^>]+csrf-token/i), A(/\/storage\//i),
  ] },
  { id: 'nextjs', name: 'Next', category: 'Framework', strong: true, markers: [
    M(/__NEXT_DATA__/), A(/\/_next\/static\//),
  ] },
  { id: 'nuxt', name: 'Nuxt', category: 'Framework', strong: true, markers: [
    M(/__NUXT__/), A(/\/_nuxt\//),
  ] },
  { id: 'gatsby', name: 'Gatsby', category: 'Framework', strong: true, markers: [
    M(/gatsby-/i), D(/id="gatsby-focus-wrapper"/),
  ] },
  { id: 'astro', name: 'Astro', category: 'Framework', strong: true, markers: [
    M(/astro-island|astro-slot/i),
  ] },
  { id: 'vue', name: 'Vue', category: 'Frontend framework', strong: true, markers: [
    A(/vue(\.global|\.runtime)?(\.prod)?\.min\.js/i), M(/data-v-[a-f0-9]{8}/),
  ] },
  { id: 'angular', name: 'Angular', category: 'Frontend framework', strong: true, markers: [
    M(/ng-version=/), A(/main\.[a-f0-9]+\.js/i),
  ] },
  { id: 'react', name: 'React', category: 'Frontend framework', strong: false, markers: [
    A(/react-dom.*\.production\.min\.js|react\.\d+\.production/i),
  ] },
  // Languages / runtimes
  { id: 'php', name: 'PHP', category: 'Language', strong: true, markers: [
    H(/php\//i), C(/PHPSESSID/i),
  ] },
  { id: 'aspnet', name: 'ASP.NET', category: 'Framework', strong: true, markers: [
    H(/asp\.net|x-aspnet/i), C(/ASP\.NET_SessionId|__RequestVerificationToken/i),
  ] },
  // Servers / CDN / security
  { id: 'nginx', name: 'Nginx', category: 'Web server', strong: true, markers: [H(/^nginx/i)] },
  { id: 'apache', name: 'Apache', category: 'Web server', strong: true, markers: [H(/^apache/i)] },
  { id: 'cloudflare', name: 'Cloudflare', category: 'CDN/Security', strong: true, markers: [
    H(/cloudflare/i), H(/cf-ray/i), C(/__cfduid|cf_clearance/i),
  ] },
  { id: 'cloudfront', name: 'CloudFront', category: 'CDN', strong: true, markers: [H(/cloudfront/i)] },
  // Analytics / marketing
  { id: 'ga', name: 'Google Analytics', category: 'Analytics', strong: true, markers: [
    A(/googletagmanager\.com\/(gtag\/js|gtm\.js)|google-analytics\.com\/(ga|analytics)\.js/i),
  ] },
  { id: 'gtm', name: 'Google Tag Manager', category: 'Tag manager', strong: true, markers: [A(/googletagmanager\.com\/gtm\.js/i), M(/GTM-[A-Z0-9]+/)] },
  { id: 'fb-pixel', name: 'Meta Pixel', category: 'Marketing', strong: true, markers: [A(/connect\.facebook\.net\/.*fbevents/i)] },
  // Payments
  { id: 'stripe', name: 'Stripe', category: 'Payments', strong: true, markers: [A(/js\.stripe\.com/i)] },
  { id: 'paypal', name: 'PayPal', category: 'Payments', strong: true, markers: [A(/paypalobjects\.com/i)] },
  // Forms / booking / chat
  { id: 'calendly', name: 'Calendly', category: 'Booking', strong: true, markers: [A(/calendly\.com\/assets/i), M(/calendly/i)] },
  { id: 'typeform', name: 'Typeform', category: 'Forms', strong: true, markers: [A(/typeform\.com/i)] },
  { id: 'jotform', name: 'Jotform', category: 'Forms', strong: true, markers: [A(/jotform\.com/i)] },
  { id: 'tawk', name: 'Tawk.to chat', category: 'Chat', strong: true, markers: [A(/embed\.tawk\.to/i)] },
  { id: 'intercom', name: 'Intercom', category: 'Chat', strong: true, markers: [A(/widget\.intercom\.io/i)] },
  { id: 'crisp', name: 'Crisp chat', category: 'Chat', strong: true, markers: [A(/client\.crisp\.chat/i)] },
  // Dynamic call tracking (Master Directive §2): number swaps post-paint —
  // phone.ts consults the same host list before flagging plain-text numbers.
  { id: 'callrail', name: 'CallRail call tracking', category: 'Call tracking', strong: true, markers: [A(/cdn\.callrail\.com/i), M(/callrail/i)] },
  { id: 'ringba', name: 'Ringba call tracking', category: 'Call tracking', strong: true, markers: [A(/ringba\.com/i), M(/ringba/i)] },
  { id: 'whatconverts', name: 'WhatConverts call tracking', category: 'Call tracking', strong: true, markers: [A(/whatconverts\.com/i), M(/whatconverts/i)] },
  { id: 'invoca', name: 'Invoca call tracking', category: 'Call tracking', strong: true, markers: [A(/invoca\.(com|net)/i), M(/invoca/i)] },
  // Libraries / CSS
  { id: 'jquery', name: 'jQuery', category: 'Library', strong: true, markers: [A(/jquery[.-]\d+\.\d+.*\.min\.js/i)] },
  { id: 'bootstrap', name: 'Bootstrap', category: 'CSS framework', strong: true, markers: [A(/bootstrap(\.min)?\.(css|js)/i)] },
  { id: 'tailwind', name: 'Tailwind CSS', category: 'CSS framework', strong: false, markers: [M(/cdn\.tailwindcss\.com/i)] },
  { id: 'recaptcha', name: 'reCAPTCHA', category: 'Security', strong: true, markers: [A(/google\.com\/recaptcha/i)] },
];
