/**
 * Client-side JS for the rich list-section editors on the new-client /
 * edit-client forms (indexation, canonicals, schema_injections,
 * redirects.static, meta_rewrites).
 *
 * Why this lives in its own file as a single string constant:
 *   - The previous attempt (Phase E v3) built this as an array of
 *     small TypeScript strings joined with `""`. Biome auto-format
 *     swapped quote styles to minimize escapes, which produced a
 *     `<script>` block V8 rejected with "Unexpected end of input".
 *     The exact offending construct was hard to pinpoint because the
 *     concatenation merged tokens across line boundaries.
 *   - Keeping it as ONE template-literal string preserves the JS
 *     structure exactly as written, no concat-time surprises.
 *   - A unit test (tests/unit/frontend-worker/list-editor.test.ts)
 *     calls `new Function(LIST_EDITOR_JS)` to assert syntactic
 *     validity. That catches any future regression before deploy.
 *
 * Design notes on the JS:
 *   - The textarea#config_json is the source of truth. All inputs
 *     read from / write to it via JSON.parse / JSON.stringify.
 *   - List entries are addressed via dotted data-path attributes,
 *     e.g. `data-path="indexation.0.match"`. Numeric labels are
 *     parsed to array indices.
 *   - Add / Remove buttons mutate the JSON, then call
 *     `renderListSection(key)` which rebuilds the entry cards from
 *     the JSON. The textarea is kept in sync after each mutation.
 *   - Hand-edits to the JSON textarea trigger a signature-diff
 *     re-render so the form stays consistent.
 *
 * Note on `\${`: this string contains no `${...}` interpolation
 * intended for the runtime — but if any are added later they must
 * be written as `\${...}` to escape from TypeScript's template-
 * literal interpolation here.
 */

export const LIST_EDITOR_JS = String.raw`
(function () {
  var ta = document.getElementById('config_json');
  if (!ta) return;

  function safeParse() {
    try { return JSON.parse(ta.value); } catch (e) { return null; }
  }
  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function pathParts(s) {
    return s.split('.').map(function (x) {
      return /^\d+$/.test(x) ? parseInt(x, 10) : x;
    });
  }
  function getByPath(j, p) {
    var c = j;
    for (var i = 0; i < p.length; i++) {
      if (c == null) return undefined;
      c = c[p[i]];
    }
    return c;
  }
  function setByPath(j, p, v) {
    var c = j;
    for (var i = 0; i < p.length - 1; i++) {
      var k = p[i], nk = p[i + 1];
      var nIsIdx = /^\d+$/.test(String(nk));
      if (c[k] == null || typeof c[k] !== 'object') c[k] = nIsIdx ? [] : {};
      c = c[k];
    }
    var lk = p[p.length - 1];
    c[lk] = v;
  }

  // Default-entry factories per list key — sensible starting shape that
  // immediately validates against the Zod schema on submit.
  var DEFAULTS = {
    'indexation': function () {
      return { match: '^/.*', robots: 'noindex,follow', additional_directives: [] };
    },
    'canonicals': function () {
      return {
        match: '^/.*',
        strategy: { type: 'origin' },
        sync_og_url: true,
        sync_twitter_url: true,
        sync_jsonld_url: true,
      };
    },
    'schema_injections': function () {
      return {
        match: '^/.*',
        schema_type: 'Article',
        position: 'head_append',
        payload: {
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: 'Example Article Title',
          author: { '@type': 'Person', name: 'Author Name' },
        },
      };
    },
    'redirects.static': function () {
      return { from: '/old-path', to: '/new-path', status: '301', preserve_query: true };
    },
    'meta_rewrites': function () {
      return { match: '^/.*', tag: 'title', value: 'Example Page Title' };
    },
    'text_rewrites': function () {
      return { match: '^/.*', selector: 'h1', mode: 'text', content: 'New heading' };
    },
  };

  // Renderers per list key. Each takes (entry, idx) and returns one
  // entry card's HTML. They reference data-path attributes so the
  // delegated input handler below can sync changes back to JSON.

  function renderIndexationEntry(e, idx) {
    var dirs = Array.isArray(e.additional_directives) ? e.additional_directives : [];
    var dirOpts = ['noarchive', 'nosnippet', 'max-image-preview:large', 'max-snippet:-1'];
    var robotsOpts = ['index,follow', 'noindex,follow', 'noindex,nofollow', 'index,nofollow'];
    var robotsHtml = robotsOpts
      .map(function (v) {
        return '<option value="' + v + '"' + (e.robots === v ? ' selected' : '') + '>' + v + '</option>';
      })
      .join('');
    var dirsHtml = dirOpts
      .map(function (opt) {
        var checked = dirs.indexOf(opt) !== -1 ? ' checked' : '';
        return (
          '<label class="checkbox-inline">' +
          '<input type="checkbox" data-path="indexation.' + idx + '.additional_directives" data-checkbox-value="' + escAttr(opt) + '"' + checked + '> ' +
          escAttr(opt) +
          '</label>'
        );
      })
      .join('');
    return (
      '<div class="list-entry">' +
        '<div class="form-grid">' +
          '<div><label>match (regex)</label><input type="text" data-path="indexation.' + idx + '.match" value="' + escAttr(e.match) + '" placeholder="^/.*"></div>' +
          '<div><label>robots</label><select data-path="indexation.' + idx + '.robots">' + robotsHtml + '</select></div>' +
          '<div class="full-width"><label>additional_directives</label><div class="checkbox-row">' + dirsHtml + '</div></div>' +
        '</div>' +
        '<div class="list-entry-foot">' +
          '<button type="button" class="btn btn-danger" data-remove-from="indexation" data-remove-idx="' + idx + '">Remove</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderCanonicalEntry(e, idx) {
    var stype = (e.strategy && e.strategy.type) || 'origin';
    var surl = (e.strategy && e.strategy.url) || '';
    var typeOpts = ['self', 'origin', 'custom', 'noindex'];
    var typeHtml = typeOpts
      .map(function (v) {
        return '<option value="' + v + '"' + (stype === v ? ' selected' : '') + '>' + v + '</option>';
      })
      .join('');
    var urlField = '';
    if (stype === 'custom') {
      urlField =
        '<div class="full-width"><label>strategy.url</label>' +
        '<input type="text" data-path="canonicals.' + idx + '.strategy.url" value="' + escAttr(surl) + '" placeholder="https://example.com/canonical-target">' +
        '</div>';
    }
    return (
      '<div class="list-entry">' +
        '<div class="form-grid">' +
          '<div><label>match (regex)</label><input type="text" data-path="canonicals.' + idx + '.match" value="' + escAttr(e.match) + '" placeholder="^/blog/.*"></div>' +
          '<div><label>strategy.type</label><select data-path="canonicals.' + idx + '.strategy.type">' + typeHtml + '</select></div>' +
          urlField +
          '<div><label class="checkbox-inline"><input type="checkbox" data-path="canonicals.' + idx + '.sync_og_url" data-bool="1"' + (e.sync_og_url !== false ? ' checked' : '') + '> sync og:url</label></div>' +
          '<div><label class="checkbox-inline"><input type="checkbox" data-path="canonicals.' + idx + '.sync_twitter_url" data-bool="1"' + (e.sync_twitter_url !== false ? ' checked' : '') + '> sync twitter:url</label></div>' +
          '<div><label class="checkbox-inline"><input type="checkbox" data-path="canonicals.' + idx + '.sync_jsonld_url" data-bool="1"' + (e.sync_jsonld_url !== false ? ' checked' : '') + '> sync JSON-LD url</label></div>' +
        '</div>' +
        '<div class="list-entry-foot">' +
          '<button type="button" class="btn btn-danger" data-remove-from="canonicals" data-remove-idx="' + idx + '">Remove</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderSchemaInjectionEntry(e, idx) {
    var schemaTypes = ['FAQPage', 'Article', 'LocalBusiness', 'Service', 'BreadcrumbList', 'HowTo', 'Speakable', 'Product'];
    var positions = ['head_append', 'head_prepend'];
    var typeHtml = schemaTypes
      .map(function (v) {
        return '<option value="' + v + '"' + (e.schema_type === v ? ' selected' : '') + '>' + v + '</option>';
      })
      .join('');
    var posHtml = positions
      .map(function (v) {
        return '<option value="' + v + '"' + (e.position === v ? ' selected' : '') + '>' + v + '</option>';
      })
      .join('');
    var payloadStr;
    try { payloadStr = JSON.stringify(e.payload || {}, null, 2); } catch (err) { payloadStr = '{}'; }
    return (
      '<div class="list-entry">' +
        '<div class="form-grid">' +
          '<div><label>match (regex)</label><input type="text" data-path="schema_injections.' + idx + '.match" value="' + escAttr(e.match) + '" placeholder="^/products/.*"></div>' +
          '<div><label>schema_type</label><select data-path="schema_injections.' + idx + '.schema_type">' + typeHtml + '</select></div>' +
          '<div><label>position</label><select data-path="schema_injections.' + idx + '.position">' + posHtml + '</select></div>' +
          '<div class="full-width"><label>payload (JSON-LD)</label>' +
            '<textarea data-path="schema_injections.' + idx + '.payload" data-json="1" style="min-height:140px">' + escAttr(payloadStr) + '</textarea>' +
            '<div class="field-hint">Must parse as JSON. Edit @context, @type, and properties for the schema_type above.</div>' +
          '</div>' +
        '</div>' +
        '<div class="list-entry-foot">' +
          '<button type="button" class="btn btn-danger" data-remove-from="schema_injections" data-remove-idx="' + idx + '">Remove</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderStaticRedirectEntry(e, idx) {
    var statusOpts = ['301', '302', '307', '308', '410'];
    var statusHtml = statusOpts
      .map(function (v) {
        var cur = e.status || '301';
        return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + v + '</option>';
      })
      .join('');
    return (
      '<div class="list-entry">' +
        '<div class="form-grid">' +
          '<div><label>from (path)</label><input type="text" data-path="redirects.static.' + idx + '.from" value="' + escAttr(e.from) + '" placeholder="/old-page"></div>' +
          '<div><label>to (path or URL)</label><input type="text" data-path="redirects.static.' + idx + '.to" value="' + escAttr(e.to) + '" placeholder="/new-page"></div>' +
          '<div><label>status</label><select data-path="redirects.static.' + idx + '.status">' + statusHtml + '</select></div>' +
          '<div><label class="checkbox-inline"><input type="checkbox" data-path="redirects.static.' + idx + '.preserve_query" data-bool="1"' + (e.preserve_query !== false ? ' checked' : '') + '> preserve query string</label></div>' +
        '</div>' +
        '<div class="list-entry-foot">' +
          '<button type="button" class="btn btn-danger" data-remove-from="redirects.static" data-remove-idx="' + idx + '">Remove</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderTextRewriteEntry(e, idx) {
    var modes = ['text', 'html'];
    var modeHtml = modes
      .map(function (v) {
        var cur = e.mode || 'text';
        return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + v + '</option>';
      })
      .join('');
    // Quick-pick selector presets shown as a comma-separated hint —
    // operator can paste any CSS selector but these are the common ones.
    return (
      '<div class="list-entry">' +
        '<div class="form-grid">' +
          '<div><label>match (regex)</label><input type="text" data-path="text_rewrites.' + idx + '.match" value="' + escAttr(e.match) + '" placeholder="^/$"></div>' +
          '<div><label>selector (CSS)</label><input type="text" data-path="text_rewrites.' + idx + '.selector" value="' + escAttr(e.selector) + '" placeholder="h1">' +
            '<div class="field-hint">Examples: <code>h1</code>, <code>h2.hero-title</code>, <code>main p:first-of-type</code>, <code>[data-cta]</code></div>' +
          '</div>' +
          '<div><label>mode</label><select data-path="text_rewrites.' + idx + '.mode">' + modeHtml + '</select>' +
            '<div class="field-hint"><strong>text</strong> (safe) escapes HTML chars. <strong>html</strong> renders raw HTML — for spans, links, etc.</div>' +
          '</div>' +
          '<div class="full-width"><label>content</label>' +
            '<textarea data-path="text_rewrites.' + idx + '.content" style="min-height:80px">' + escAttr(e.content) + '</textarea>' +
            '<div class="field-hint">The replacement. Element\'s attributes / classes / surrounding markup are preserved.</div>' +
          '</div>' +
        '</div>' +
        '<div class="list-entry-foot">' +
          '<button type="button" class="btn btn-danger" data-remove-from="text_rewrites" data-remove-idx="' + idx + '">Remove</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderMetaRewriteEntry(e, idx) {
    var tags = ['title', 'description', 'robots', 'og:title', 'og:description', 'og:image', 'og:type', 'og:site_name', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'];
    var tagHtml = tags
      .map(function (v) {
        return '<option value="' + v + '"' + (e.tag === v ? ' selected' : '') + '>' + v + '</option>';
      })
      .join('');
    return (
      '<div class="list-entry">' +
        '<div class="form-grid">' +
          '<div><label>match (regex)</label><input type="text" data-path="meta_rewrites.' + idx + '.match" value="' + escAttr(e.match) + '" placeholder="^/products/.*"></div>' +
          '<div><label>tag</label><select data-path="meta_rewrites.' + idx + '.tag">' + tagHtml + '</select></div>' +
          '<div class="full-width"><label>value</label><input type="text" data-path="meta_rewrites.' + idx + '.value" value="' + escAttr(e.value) + '" placeholder="Example tag value"></div>' +
        '</div>' +
        '<div class="list-entry-foot">' +
          '<button type="button" class="btn btn-danger" data-remove-from="meta_rewrites" data-remove-idx="' + idx + '">Remove</button>' +
        '</div>' +
      '</div>'
    );
  }

  var RENDERERS = {
    'indexation': renderIndexationEntry,
    'canonicals': renderCanonicalEntry,
    'schema_injections': renderSchemaInjectionEntry,
    'redirects.static': renderStaticRedirectEntry,
    'meta_rewrites': renderMetaRewriteEntry,
    'text_rewrites': renderTextRewriteEntry,
  };

  function renderListSection(key) {
    var container = document.querySelector('[data-list-container="' + key + '"]');
    if (!container) return;
    var json = safeParse();
    if (!json) return;
    var arr = getByPath(json, pathParts(key));
    if (!Array.isArray(arr)) arr = [];
    if (arr.length === 0) {
      container.innerHTML = '<div class="empty">none configured — click + Add to create one</div>';
      return;
    }
    var renderer = RENDERERS[key];
    container.innerHTML = arr.map(function (e, i) { return renderer(e, i); }).join('');
  }

  function renderAllLists() {
    Object.keys(RENDERERS).forEach(renderListSection);
  }

  // Delegated input handler for entry-card fields.
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.dataset || !t.dataset.path) return;
    var json = safeParse();
    if (!json) return;
    var p = pathParts(t.dataset.path);

    if (t.dataset.checkboxValue !== undefined) {
      // Multi-select checkbox: t.dataset.checkboxValue is the array element
      // value. Toggle its presence in the array at the path.
      var cur = getByPath(json, p);
      if (!Array.isArray(cur)) cur = [];
      var val = t.dataset.checkboxValue;
      var has = cur.indexOf(val) !== -1;
      if (t.checked && !has) cur.push(val);
      else if (!t.checked && has) cur.splice(cur.indexOf(val), 1);
      setByPath(json, p, cur);
      ta.value = JSON.stringify(json, null, 2);
      return;
    }

    var v;
    if (t.dataset.bool === '1') {
      v = !!t.checked;
    } else if (t.dataset.json === '1') {
      try {
        v = JSON.parse(t.value);
        t.style.borderColor = '';
      } catch (err) {
        t.style.borderColor = 'var(--red)';
        return;
      }
    } else {
      v = t.value;
    }
    setByPath(json, p, v);
    ta.value = JSON.stringify(json, null, 2);

    // Re-render canonicals when strategy.type changes (it gates the
    // strategy.url field's visibility).
    if (t.dataset.path.indexOf('canonicals.') === 0 && t.dataset.path.indexOf('.strategy.type') !== -1) {
      renderListSection('canonicals');
    }
  });

  // Selects fire 'change' but in some browsers not 'input' — re-emit so the
  // single input handler above sees the change.
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.dataset || !t.dataset.path) return;
    if (t.tagName === 'SELECT' || t.type === 'checkbox') {
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // Delegated click handler for + Add and Remove buttons.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.dataset) return;

    if (t.dataset.addTo) {
      var json = safeParse();
      if (!json) {
        alert('JSON has parse errors — fix them in the textarea before adding entries.');
        return;
      }
      var key = t.dataset.addTo;
      var fac = DEFAULTS[key];
      if (!fac) return;
      var p = pathParts(key);
      var arr = getByPath(json, p);
      if (!Array.isArray(arr)) {
        arr = [];
        setByPath(json, p, arr);
      }
      arr.push(fac());
      ta.value = JSON.stringify(json, null, 2);
      renderListSection(key);
      return;
    }

    if (t.dataset.removeFrom) {
      var json2 = safeParse();
      if (!json2) return;
      var key2 = t.dataset.removeFrom;
      var idx = parseInt(t.dataset.removeIdx, 10);
      var p2 = pathParts(key2);
      var arr2 = getByPath(json2, p2);
      if (Array.isArray(arr2)) {
        arr2.splice(idx, 1);
        ta.value = JSON.stringify(json2, null, 2);
        renderListSection(key2);
      }
      return;
    }
  });

  // When the user hand-edits the JSON textarea, re-render the list
  // sections IF the affected slices changed. Cheap signature comparison
  // avoids a full re-render on every keystroke (which would lose
  // textarea focus).
  var lastSig = '';
  function maybeRerenderLists() {
    var j = safeParse();
    if (!j) return;
    var sig = JSON.stringify({
      i: j.indexation,
      c: j.canonicals,
      s: j.schema_injections,
      r: j.redirects && j.redirects.static,
      m: j.meta_rewrites,
      t: j.text_rewrites,
    });
    if (sig !== lastSig) {
      lastSig = sig;
      renderAllLists();
    }
  }
  ta.addEventListener('input', maybeRerenderLists);

  renderAllLists();
  maybeRerenderLists();
})();
`;
