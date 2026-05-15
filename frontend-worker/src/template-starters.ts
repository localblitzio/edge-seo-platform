/**
 * Pre-baked starter templates the operator can clone into a real
 * `site_templates` row via /app/templates/new?starter=<id>.
 *
 * Each starter ships with a clean HTML skeleton (semantic h1/h2/p,
 * inline `<style>` for self-contained rendering, schema.org JSON-LD
 * where it fits) and a path pattern aligned with its expected data
 * shape:
 *
 *   - "city-service-landing"   — one subdomain per city. Pairs with
 *                                 a hand-typed CSV (city, service,
 *                                 phone, intro).
 *   - "business-profile"        — one subdomain per business. Pairs
 *                                 with a `dataforseo_business_listings`
 *                                 scrape (columns line up 1:1).
 *   - "city-directory-page"     — appends /services-in-<city> pages
 *                                 under an existing brand. Pairs with
 *                                 a hand-typed CSV.
 *
 * Adding a starter is just appending to the array — operators get the
 * card automatically. Move to a DB-backed CRUD UI when we hit ≥ 5.
 */

import type { TemplateKind } from "./site-templates.js";

export interface TemplateStarter {
  id: string;
  label: string;
  /** One-line description shown on the starter card. */
  description: string;
  /** Human-readable hint about which data source kind to pair with. */
  bestWith: string;
  /** Pre-fills the form on /app/templates/new?starter=<id>. */
  kind: TemplateKind;
  name: string;
  path_pattern: string;
  html_template: string;
}

const CITY_SERVICE_LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{service}} in {{city}} | Top Local Pros</title>
  <meta name="description" content="Looking for {{service}} in {{city}}? Get a fast quote from a trusted local pro. Free estimates, licensed, and insured.">
  <style>
    *{box-sizing:border-box}
    body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif;color:#111;background:#fafafb}
    .container{max-width:780px;margin:0 auto;padding:2rem 1.25rem}
    h1{font-size:clamp(1.8rem,3.5vw,2.6rem);line-height:1.15;margin:.2em 0 .4em}
    h2{font-size:1.4rem;margin:2rem 0 .5rem}
    .lede{font-size:1.1rem;color:#444;margin-bottom:1.5rem}
    .cta{display:inline-block;background:#10b981;color:#fff;padding:.85rem 1.6rem;border-radius:.55rem;font-weight:600;text-decoration:none;margin:.5rem 0}
    .cta:hover{background:#059669}
    .phone{font-weight:700;color:#10b981}
    ul.bullets{padding-left:1.2rem}
    ul.bullets li{margin:.35em 0}
    footer{margin-top:3rem;padding-top:1.5rem;border-top:1px solid #e5e7eb;color:#6b7280;font-size:.9rem}
  </style>
</head>
<body>
  <div class="container">
    <h1>Top-rated {{service}} in {{city}}</h1>
    <p class="lede">Need {{service}} in {{city}}? Get fast, free quotes from licensed local pros — no obligation, no spam.</p>
    {{#if phone}}<p>Call now: <a class="phone" href="tel:{{phone}}">{{phone}}</a></p>{{/if}}
    <a class="cta" href="#contact">Get a free quote →</a>

    <h2>Why choose a {{city}} pro?</h2>
    <ul class="bullets">
      <li>Licensed, bonded, and insured for work in {{city}}</li>
      <li>Free estimates with no obligation</li>
      <li>Local team that knows {{city}} neighborhoods and codes</li>
      <li>Background-checked technicians</li>
    </ul>

    {{#if intro}}<h2>About {{service}} in {{city}}</h2>
    <p>{{intro}}</p>{{/if}}

    {{#if city_description}}<h2>About {{city}}</h2>
    <p>{{city_description}}</p>{{/if}}

    <h2 id="contact">Request a quote</h2>
    <p>Tell us about your project and we'll match you with a vetted {{service}} provider serving {{city}}.</p>
    {{#if phone}}<p>Or call <a class="phone" href="tel:{{phone}}">{{phone}}</a> to speak with someone today.</p>{{/if}}

    <footer>© {{city}} {{service}} · Serving the {{city}} area</footer>
  </div>
</body>
</html>`;

const BUSINESS_PROFILE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{title}} — {{city}}, {{state}}</title>
  <meta name="description" content="{{title}} in {{city}}, {{state}}. {{categories}}. {{#if rating}}Rated {{rating}}/5 by customers.{{/if}}">
  <style>
    *{box-sizing:border-box}
    body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif;color:#111;background:#fafafb}
    .container{max-width:760px;margin:0 auto;padding:2rem 1.25rem}
    h1{font-size:clamp(1.6rem,3vw,2.3rem);line-height:1.2;margin:.2em 0}
    .meta{color:#6b7280;font-size:.95rem;margin:.3rem 0 1.2rem}
    .rating{color:#d97706;font-weight:600}
    .price{color:#10b981;font-weight:600;margin-left:.4rem}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:.6rem;padding:1.1rem 1.3rem;margin:1rem 0;box-shadow:0 1px 3px rgba(15,23,42,.05)}
    .label{color:#6b7280;font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;margin-bottom:.25rem}
    .phone{font-weight:700;color:#10b981;font-size:1.15rem}
    .hero{margin:0 -1.25rem 1rem;aspect-ratio:16/9;background-size:cover;background-position:center;background-color:#e5e7eb}
    @media(min-width:760px){.hero{margin:0 0 1.25rem;border-radius:.6rem}}
    .gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:.5rem;margin:.5rem 0}
    .gallery img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:.4rem;background:#e5e7eb}
    .hours{list-style:none;padding:0;margin:.25rem 0;font-size:.92rem}
    .hours li{display:flex;justify-content:space-between;padding:.2rem 0;border-bottom:1px dotted #e5e7eb}
    .hours li:last-child{border-bottom:0}
    .hours .day{text-transform:capitalize}
    .hours .time{color:#374151;font-variant-numeric:tabular-nums}
    .hours .closed{color:#9ca3af}
    .badges{display:flex;flex-wrap:wrap;gap:.35rem;margin:.5rem 0}
    .badge{font-size:.74rem;padding:.2rem .5rem;background:#d1fae5;color:#065f46;border-radius:9999px}
    .map-wrap{aspect-ratio:16/10;border-radius:.5rem;overflow:hidden;border:1px solid #e5e7eb}
    .map-wrap iframe{width:100%;height:100%;border:0}
    .cta{display:inline-block;background:#10b981;color:#fff;padding:.85rem 1.6rem;border-radius:.55rem;font-weight:600;text-decoration:none;margin:.5rem 0}
    .cta:hover{background:#059669}
    .maps-link{font-size:.85rem;color:#6b7280}
    footer{margin-top:2.5rem;padding-top:1.25rem;border-top:1px solid #e5e7eb;color:#6b7280;font-size:.9rem}
  </style>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "name": "{{title}}",
    "description": "{{description}}",
    "image": "{{main_image_url}}",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "{{address}}",
      "addressLocality": "{{city}}",
      "addressRegion": "{{state}}",
      "postalCode": "{{zip}}",
      "addressCountry": "{{country}}"
    }{{#if latitude}},
    "geo": {"@type": "GeoCoordinates", "latitude": "{{latitude}}", "longitude": "{{longitude}}"}{{/if}}{{#if phone}},
    "telephone": "{{phone}}"{{/if}}{{#if website}},
    "url": "{{website}}"{{/if}}{{#if price_level}},
    "priceRange": "{{price_level}}"{{/if}}{{#if rating}},
    "aggregateRating": {"@type": "AggregateRating", "ratingValue": "{{rating}}", "reviewCount": "{{rating_count}}"}{{/if}}{{#if place_id}},
    "sameAs": ["https://www.google.com/maps/place/?q=place_id:{{place_id}}"]{{/if}}
  }
  </script>
</head>
<body>
  <div class="container">
    {{#if main_image_url}}<div class="hero" style="background-image:url('{{main_image_url}}')"></div>{{/if}}

    <h1>{{title}}</h1>
    <div class="meta">
      {{categories}}{{#if city}} · {{city}}{{/if}}{{#if state}}, {{state}}{{/if}}
      {{#if price_level}}<span class="price">{{price_level}}</span>{{/if}}
      {{#if rating}}<br><span class="rating">★ {{rating}}</span> · {{rating_count}} reviews{{/if}}
    </div>

    {{#if description}}<p style="color:#374151;font-size:1.02rem">{{description}}</p>{{/if}}

    <div class="card">
      <div class="label">Address</div>
      <div>{{address}}</div>
      {{#if place_id}}<a class="maps-link" href="https://www.google.com/maps/place/?q=place_id:{{place_id}}" target="_blank" rel="noopener nofollow">View on Google Maps →</a>{{/if}}
    </div>

    {{#if phone}}<div class="card">
      <div class="label">Phone</div>
      <a class="phone" href="tel:{{phone}}">{{phone}}</a>
    </div>{{/if}}

    {{#if website}}<div class="card">
      <div class="label">Website</div>
      <a href="{{website}}" rel="nofollow noopener" target="_blank">{{website}}</a>
    </div>{{/if}}

    {{#if hours_json}}<div class="card">
      <div class="label">Hours</div>
      <!-- hours_json is consumed by a tiny inline script below; keep raw for the renderer. -->
      <div data-hours='{{{hours_json}}}'></div>
    </div>{{/if}}

    {{#if latitude}}<div class="card">
      <div class="label">Map</div>
      <div class="map-wrap">
        <iframe loading="lazy" src="https://maps.google.com/maps?q={{latitude}},{{longitude}}&z=15&output=embed" referrerpolicy="no-referrer-when-downgrade"></iframe>
      </div>
    </div>{{/if}}

    {{#if phone}}<a class="cta" href="tel:{{phone}}">Call {{title}} →</a>{{/if}}

    {{#if has_reviews}}<div class="card" style="background:#fff">
      <div class="label">Customer reviews</div>
      <!-- reviews_json is consumed by the inline script below. -->
      <div data-reviews='{{{reviews_json}}}'></div>
    </div>{{/if}}

    {{#if has_cross_links}}<div class="card" style="background:#f9fafb">
      <div class="label">Related businesses</div>
      <ul style="margin:.4rem 0;padding-left:1.2rem;line-height:1.7">
        {{#each cross_links}}<li><a href="{{url}}">{{title}}</a> <span style="color:#6b7280;font-size:.85rem">— {{context}}</span></li>{{/each}}
      </ul>
    </div>{{/if}}

    <footer>Information about {{title}} sourced from public Google Maps data. Listing accuracy is the responsibility of the business.</footer>
  </div>

  <script>
    // Render hours from data-hours JSON into a clean list. Pure
    // client-side so the HTML stays valid even when hours_json is
    // an unknown shape.
    (function(){
      var nodes = document.querySelectorAll('[data-hours]');
      var days = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
      nodes.forEach(function(el){
        var raw = el.getAttribute('data-hours') || '';
        if (raw === '24/7') { el.textContent = 'Open 24 hours'; return; }
        try {
          var h = JSON.parse(raw);
          var ul = document.createElement('ul'); ul.className = 'hours';
          days.forEach(function(d){
            var t = h[d] || 'closed';
            var li = document.createElement('li');
            var nameSpan = document.createElement('span'); nameSpan.className = 'day'; nameSpan.textContent = d;
            var timeSpan = document.createElement('span'); timeSpan.className = 'time' + (t === 'closed' ? ' closed' : ''); timeSpan.textContent = t === 'closed' ? 'Closed' : t;
            li.appendChild(nameSpan); li.appendChild(timeSpan); ul.appendChild(li);
          });
          el.parentNode.replaceChild(ul, el);
        } catch(e) { el.textContent = raw; }
      });
    })();
    // Render reviews from data-reviews JSON.
    (function(){
      var nodes = document.querySelectorAll('[data-reviews]');
      nodes.forEach(function(el){
        var raw = el.getAttribute('data-reviews') || '';
        try {
          var arr = JSON.parse(raw);
          if (!Array.isArray(arr) || arr.length === 0) { el.remove(); return; }
          var frag = document.createDocumentFragment();
          arr.forEach(function(r){
            var b = document.createElement('blockquote');
            b.style.cssText = 'margin:.8rem 0;padding:.55rem .9rem;border-left:3px solid #10b981;font-style:italic;color:#374151';
            var p = document.createElement('p'); p.style.margin = '0 0 .35rem'; p.textContent = '"' + r.text + '"';
            var meta = document.createElement('div'); meta.style.cssText = 'font-size:.82rem;color:#6b7280;font-style:normal';
            meta.textContent = (r.author || 'Customer') + (r.rating ? ' · ★ ' + r.rating : '') + (r.date ? ' · ' + r.date : '');
            b.appendChild(p); b.appendChild(meta);
            frag.appendChild(b);
          });
          el.parentNode.replaceChild(frag, el);
        } catch(e) { el.remove(); }
      });
    })();
  </script>
</body>
</html>`;

const CITY_DIRECTORY_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{service}} in {{city}} | Local Directory</title>
  <meta name="description" content="Find vetted {{service}} providers in {{city}}. Read reviews, compare quotes, and hire with confidence.">
  <style>
    *{box-sizing:border-box}
    body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif;color:#111}
    .container{max-width:820px;margin:0 auto;padding:2rem 1.25rem}
    h1{font-size:clamp(1.7rem,3vw,2.4rem);margin:0 0 .35em}
    h2{font-size:1.3rem;margin:1.8rem 0 .5rem}
    .lede{color:#444;margin-bottom:1rem}
    .crumbs{font-size:.85rem;color:#6b7280;margin-bottom:.5rem}
    .crumbs a{color:#10b981;text-decoration:none}
    ul.bullets li{margin:.35em 0}
  </style>
</head>
<body>
  <div class="container">
    <div class="crumbs"><a href="/">Home</a> · <a href="/services">Services</a> · {{city}}</div>
    <h1>{{service}} in {{city}}</h1>
    <p class="lede">Connect with trusted {{service}} providers serving {{city}} and nearby neighborhoods.</p>

    {{#if intro}}<p>{{intro}}</p>{{/if}}

    <h2>What to look for in {{city}}</h2>
    <ul class="bullets">
      <li>Licensed for work in {{city}} and the surrounding area</li>
      <li>Insurance and bonding documentation on request</li>
      <li>References from prior {{city}} clients</li>
      <li>Clear, itemized quotes</li>
    </ul>

    <h2>Service areas near {{city}}</h2>
    <p>Our {{service}} network covers {{city}} and adjacent communities. Get matched with a local pro by submitting a quote request.</p>
  </div>
</body>
</html>`;

export const TEMPLATE_STARTERS: readonly TemplateStarter[] = [
  {
    id: "city-service-landing",
    label: "City service landing",
    description:
      "One single-page subdomain per city — clear CTA + bullets. Great for paid landers or geo-targeted SEO.",
    bestWith: "Hand-typed CSV (columns: city, service, phone, intro)",
    kind: "client_per_row",
    name: "City service landing",
    path_pattern: "/",
    html_template: CITY_SERVICE_LANDING_HTML,
  },
  {
    id: "business-profile",
    label: "Business profile",
    description:
      "One subdomain per business with LocalBusiness schema, click-to-call, and rating. Drop straight onto a Maps scrape.",
    bestWith: "Maps scrape (DataForSEO Business Listings)",
    kind: "client_per_row",
    name: "Business profile",
    path_pattern: "/",
    html_template: BUSINESS_PROFILE_HTML,
  },
  {
    id: "city-directory-page",
    label: "City directory page",
    description:
      "Adds a /services-in-<city> page under an existing brand. Use this for deep-page coverage on one main site.",
    bestWith: "Hand-typed CSV (columns: city, service, intro)",
    kind: "pages_in_client",
    name: "City directory page",
    path_pattern: "/{{slugify service}}-in-{{slugify city}}",
    html_template: CITY_DIRECTORY_PAGE_HTML,
  },
];

export function getTemplateStarter(id: string): TemplateStarter | null {
  return TEMPLATE_STARTERS.find((s) => s.id === id) ?? null;
}
