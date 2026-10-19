// Interactive controllers for docs/index.html and docs/reference.html:
// 1. Hero CLI Command Launcher ([data-cli-tab])
// 2. Cloud Box 100 :DISPLAY Slot Rack Simulator ([data-slot-btn])
// 3. Arrakis-style Workflow Evolution & Playbook Stepper ([data-evo-tab])
// 4. Live CLI Capabilities Filter Pills + Instant Search ([data-cap-filter], [data-cap-search])
// 5. Floating Awwwards Bottom Dock Scroll-Spy ([data-dock-link])
// 6. Reference Page Live Search/Filters ([data-ref]) & Code Copy Buttons (.code)

(function () {
  // 1. Hero CLI Command Launcher
  var cliTabs = document.querySelectorAll("[data-cli-tab]");
  var cliCmdEl = document.querySelector("[data-cli-cmd]");
  var cliOutEl = document.querySelector("[data-cli-out]");
  var cliExamples = {
    ask: {
      cmd: 'grokbot ask "Grow conversion for example-org/example-app" --timeout 600',
      out: "→ Dispatched via WatchGrokBotTranscripts (0 token wait) · Done Rule verified in 16.8s"
    },
    hire: {
      cmd: 'grokbot hire market-scout --title "Competitor & Ad Analyst"',
      out: "→ Created Temporal bot in 1.5s · Assigned DISPLAY :5 + /workspace/staff/market-scout/"
    },
    room: {
      cmd: 'grokbot room create growth-sprint --members "market-scout,copy-bot,eng-bot"',
      out: "→ War Room active · Each specialist bot replies once with author {id, name}"
    },
    approvals: {
      cmd: "grokbot approvals --resolve req_9f82a --decision approved",
      out: "→ Resolved auto-review-approval card on Cloud Box · Run resumed"
    }
  };
  cliTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var key = tab.getAttribute("data-cli-tab");
      var ex = cliExamples[key];
      if (!ex) return;
      cliTabs.forEach(function (t) {
        t.setAttribute("aria-selected", String(t === tab));
      });
      if (cliCmdEl) cliCmdEl.textContent = ex.cmd;
      if (cliOutEl) cliOutEl.textContent = ex.out;
    });
  });

  // 2. Cloud Box 100 :DISPLAY Hardware Rack Simulator
  var slotBtns = document.querySelectorAll("[data-slot-btn]");
  var slotTitle = document.querySelector("[data-rack-title]");
  var slotPort = document.querySelector("[data-rack-port]");
  var slotUuid = document.querySelector("[data-rack-uuid]");
  var slotState = document.querySelector("[data-rack-state]");
  var slotDataDir = document.querySelector("[data-rack-datadir]");
  var slotWorkDir = document.querySelector("[data-rack-workdir]");
  var slotDesc = document.querySelector("[data-rack-desc]");
  var ledDots = document.querySelectorAll("[data-led-index]");

  var slotData = {
    "2": {
      title: "Grok Bot (Primary Manager)",
      port: "DISPLAY :2",
      uuid: "<main bot agentId>",
      state: "IDLE · READY",
      datadir: "/home/box/agent-data/agents/<id>/",
      workdir: "/workspace/staff/grok-manager/",
      desc: "Primary account manager bot with dedicated X11 GUI desktop, browser, and mouse. Coordinates specialist bots via SendToAgent and spawns bc-* Cursor Cloud Agents on GitHub repos.",
      led: 1
    },
    "3": {
      title: "Primary Test (Test Section)",
      port: "DISPLAY :3",
      uuid: "f882ec52-17b1-4639-b0fc-07fed7526b09",
      state: "VERIFIED · PONG",
      datadir: "/home/box/agent-data/agents/f882ec52-…/",
      workdir: "/workspace/staff/primary-test/",
      desc: "Dedicated live verification bot in the 'Test' sidebar section. Probed for EnsureSandBox gateway skill CRUD (170 -> 171 -> 170), approval cards, and X11 window slot 3.",
      led: 2
    },
    "4": {
      title: "Staff Test (Test Section)",
      port: "DISPLAY :4",
      uuid: "201a8cb2-e34a-4dd6-858c-c8601d5c2aa5",
      state: "VERIFIED · PONG",
      datadir: "/home/box/agent-data/agents/201a8cb2-…/",
      workdir: "/workspace/staff/staff-test/",
      desc: "Secondary test employee in the 'Test' sidebar section. Verified bot-to-bot direct messaging (SendGrokBotAgentMessage), multi-bot War Rooms, and isolated SQLite store.db.",
      led: 3
    },
    "open": {
      title: "96 Open Staff Slots (On-Demand Fleet)",
      port: "DISPLAY :5..:100",
      uuid: "Allocated in 1.5s via CreateGrokBotTemporalAgent",
      state: "96 SLOTS AVAILABLE",
      datadir: "/home/box/agent-data/agents/<new-uuid>/",
      workdir: "/workspace/staff/<bot-slug>/",
      desc: "Assigned in ~/.sand-window-assignments.json up to SAND_BOX_MAX_WINDOWS = 100. Stream any employee's live desktop with `grokbot vnc` via EnsureSandBoxWindow(window_index).",
      led: 4
    }
  };

  slotBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = btn.getAttribute("data-slot-btn");
      var info = slotData[key];
      if (!info) return;
      slotBtns.forEach(function (b) {
        b.setAttribute("aria-selected", String(b === btn));
      });
      if (slotTitle) slotTitle.textContent = info.title;
      if (slotPort) slotPort.textContent = info.port;
      if (slotUuid) slotUuid.textContent = info.uuid;
      if (slotState) slotState.textContent = info.state;
      if (slotDataDir) slotDataDir.textContent = info.datadir;
      if (slotWorkDir) slotWorkDir.textContent = info.workdir;
      if (slotDesc) slotDesc.textContent = info.desc;
      ledDots.forEach(function (d) {
        var idx = Number(d.getAttribute("data-led-index"));
        d.classList.toggle("led-dot--selected", idx === info.led);
      });
    });
  });

  // 3. Arrakis-Style Workflow Evolution & Playbook Stepper
  var evoTabs = document.querySelectorAll("[data-evo-tab]");
  var evoPanels = document.querySelectorAll("[data-evo-panel]");
  evoTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-evo-tab");
      evoTabs.forEach(function (t) {
        t.setAttribute("aria-selected", String(t === tab));
      });
      evoPanels.forEach(function (p) {
        p.hidden = p.getAttribute("data-evo-panel") !== target;
      });
    });
  });

  // 4. Live CLI Capabilities Filter Pills + Instant Search
  var capPills = document.querySelectorAll("[data-cap-filter]");
  var capSearch = document.querySelector("[data-cap-search]");
  var capCards = Array.prototype.slice.call(document.querySelectorAll("[data-cap]"));
  var activeCapFilter = "all";

  capCards.forEach(function (c) {
    c._searchText = c.textContent.toLowerCase();
  });

  function filterCapabilities() {
    var q = capSearch ? capSearch.value.trim().toLowerCase() : "";
    capCards.forEach(function (c) {
      var matchStatus = activeCapFilter === "all" || c.getAttribute("data-cap") === activeCapFilter;
      var matchQuery = !q || c._searchText.indexOf(q) !== -1;
      c.hidden = !(matchStatus && matchQuery);
    });
  }

  capPills.forEach(function (pill) {
    pill.addEventListener("click", function () {
      activeCapFilter = pill.getAttribute("data-cap-filter") || "all";
      capPills.forEach(function (p) {
        p.setAttribute("aria-pressed", String(p === pill));
      });
      filterCapabilities();
    });
  });
  if (capSearch) {
    capSearch.addEventListener("input", filterCapabilities);
  }

  // 5. Floating Bottom Dock Scroll-Spy
  var dockLinks = Array.prototype.slice.call(document.querySelectorAll("[data-dock-link]"));
  if (dockLinks.length && typeof IntersectionObserver !== "undefined") {
    var sectionMap = {};
    dockLinks.forEach(function (link) {
      var href = link.getAttribute("href");
      if (href && href.charAt(0) === "#") {
        var sec = document.getElementById(href.slice(1));
        if (sec) sectionMap[sec.id] = link;
      }
    });
    var spy = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting && sectionMap[entry.target.id]) {
            dockLinks.forEach(function (l) {
              l.removeAttribute("aria-current");
            });
            sectionMap[entry.target.id].setAttribute("aria-current", "true");
          }
        });
      },
      { rootMargin: "-25% 0px -60% 0px" }
    );
    Object.keys(sectionMap).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  }

  // 6. Reference Page Live Search & Filters (docs/reference.html)
  document.querySelectorAll("[data-ref]").forEach(function (ref) {
    var q = ref.querySelector("[data-q]");
    var safety = ref.querySelector("[data-safety-filter]");
    var tested = ref.querySelector("[data-tested-filter]");
    var approval = ref.querySelector("[data-approval-filter]");
    var count = ref.querySelector("[data-count]");
    var empty = ref.querySelector("[data-empty]");
    var rows = Array.prototype.slice.call(ref.querySelectorAll(".mrow"));
    rows.forEach(function (r) {
      r._t = r.textContent.toLowerCase();
    });
    function run() {
      var term = q ? q.value.trim().toLowerCase() : "";
      var shown = 0;
      rows.forEach(function (r) {
        var ok =
          (!term || r._t.indexOf(term) !== -1) &&
          (!safety || !safety.value || r.dataset.safety === safety.value) &&
          (!tested || !tested.checked || r.dataset.tested === "1") &&
          (!approval || !approval.checked || r.dataset.approval === "yes");
        r.hidden = !ok;
        if (ok) shown++;
      });
      ref.querySelectorAll("[data-area]").forEach(function (a) {
        a.hidden = !a.querySelector(".mrow:not([hidden])");
      });
      ref.querySelectorAll("details.group").forEach(function (g) {
        var n = g.querySelectorAll(".mrow:not([hidden])").length;
        g.hidden = n === 0;
        var gc = g.querySelector("[data-group-count]");
        if (gc) gc.textContent = n;
        if ((term || (safety && safety.value) || (tested && tested.checked)) && n) g.open = true;
      });
      if (empty) empty.hidden = shown !== 0;
      if (count) count.textContent = shown + " of " + rows.length;
    }
    [q, safety, tested, approval].forEach(function (el) {
      if (el) el.addEventListener("input", run);
    });
    run();
  });

  function openTarget() {
    if (!location.hash) return;
    var el = document.getElementById(location.hash.slice(1));
    if (el && el.tagName === "DETAILS") el.open = true;
  }
  window.addEventListener("hashchange", openTarget);
  openTarget();

  // 7. Copy buttons on code blocks
  document.querySelectorAll(".code").forEach(function (block) {
    if (block.querySelector(".copy-btn")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", function () {
      var pre = block.querySelector("pre");
      if (!pre) return;
      var text = pre.innerText.replace(/^\$ /gm, "");
      var done = function (ok) {
        btn.textContent = ok ? "Copied" : "Copy failed";
        setTimeout(function () {
          btn.textContent = "Copy";
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            done(true);
          },
          function () {
            done(false);
          }
        );
      } else {
        done(false);
      }
    });
    block.appendChild(btn);
  });
})();
