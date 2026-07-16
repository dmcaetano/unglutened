(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const authView = $("#authView");
  const appView = $("#appView");
  const authForm = $("#authForm");
  const authToggle = $("#authToggle");
  const nameField = $("#nameField");
  const authName = $("#authName");
  const authPassword = $("#authPassword");
  const authSubmit = $("#authSubmit");
  const authEyebrow = $("#authEyebrow");
  const authHeading = $("#authHeading");
  const authDescription = $("#authDescription");
  const headerContext = $("#headerContext");
  const chatDock = $("#chatDock");
  const toast = $("#toast");
  const previewPill = $("#previewPill");

  let signupMode = false;
  let toastTimer = 0;
  let analyzingTimer = 0;
  let replyTimer = 0;
  let activeSheet = null;
  let activeHistoryRow = null;
  let lastFocusedElement = null;

  const tabNames = ["log", "gut", "history", "insights", "chat"];
  const tabLabels = {
    log: "Log a meal",
    gut: "Daily check-in",
    history: "Your timeline",
    insights: "Your patterns",
    chat: "Ask UnGlutened"
  };

  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 2800);
  }

  function setSignupMode(enabled) {
    signupMode = enabled;
    nameField.hidden = !enabled;
    authName.required = enabled;
    authPassword.autocomplete = enabled ? "new-password" : "current-password";
    authEyebrow.textContent = enabled ? "Start your story" : "Welcome back";
    authHeading.textContent = enabled ? "Create your account" : "Good to see you";
    authDescription.textContent = enabled
      ? "A clearer view of your gut starts with one honest log."
      : "Log in to keep building your gut-health picture.";
    authSubmit.textContent = enabled ? "Create account" : "Log in";
    authToggle.textContent = enabled
      ? "Already have an account? Log in"
      : "New here? Create an account";
  }

  function enterApp() {
    authView.hidden = true;
    appView.hidden = false;
    previewPill.hidden = false;
    const hashTab = location.hash.replace("#", "");
    selectTab(tabNames.includes(hashTab) ? hashTab : "log", true);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  authToggle.addEventListener("click", () => {
    setSignupMode(!signupMode);
    (signupMode ? authName : $("#authEmail")).focus();
  });

  authForm.addEventListener("submit", event => {
    event.preventDefault();
    if (!authForm.reportValidity()) return;
    enterApp();
  });

  function selectTab(name, updateHash = true) {
    if (!tabNames.includes(name)) name = "log";

    $$("[data-screen]").forEach(screen => {
      screen.hidden = screen.dataset.screen !== name;
    });

    $$(".tab-bar [role='tab']").forEach(tab => {
      const selected = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });

    headerContext.textContent = tabLabels[name];
    chatDock.hidden = name !== "chat";
    appView.classList.toggle("chat-active", name === "chat");

    if (updateHash && location.hash !== `#${name}`) {
      history.replaceState(null, "", `#${name}`);
    }

    window.scrollTo({ top: 0, behavior: "auto" });
  }

  $$(".tab-bar [data-tab]").forEach(tab => {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab, true));

    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = tabNames.indexOf(tab.dataset.tab);
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const nextName = tabNames[(currentIndex + direction + tabNames.length) % tabNames.length];
      selectTab(nextName, true);
      $(`[data-tab="${nextName}"]`).focus();
    });
  });

  $$("[data-tab-link]").forEach(link => {
    link.addEventListener("click", event => {
      event.preventDefault();
      selectTab(link.dataset.tabLink, true);
    });
  });

  $$("[data-go-tab]").forEach(button => {
    button.addEventListener("click", () => selectTab(button.dataset.goTab, true));
  });

  window.addEventListener("hashchange", () => {
    if (appView.hidden) return;
    const name = location.hash.replace("#", "");
    if (tabNames.includes(name)) selectTab(name, false);
  });

  previewPill.addEventListener("click", () => {
    previewPill.hidden = true;
  });

  const todayPill = $("#todayPill");
  const currentDate = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short"
  }).format(new Date());
  todayPill.textContent = `Today · ${currentDate}`;

  const captureCard = $("#captureCard");
  const mealResult = $("#mealResult");
  const describeForm = $("#describeForm");

  function runAnalysis() {
    clearTimeout(analyzingTimer);
    captureCard.classList.remove("is-ready");
    captureCard.classList.add("is-analyzing");
    captureCard.disabled = true;
    mealResult.hidden = true;

    analyzingTimer = window.setTimeout(() => {
      captureCard.classList.remove("is-analyzing");
      captureCard.classList.add("is-ready");
      captureCard.disabled = false;
      mealResult.hidden = false;
      updateDetectedBadges();
      mealResult.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 1500);
  }

  captureCard.addEventListener("click", runAnalysis);

  describeForm.addEventListener("submit", event => {
    event.preventDefault();
    runAnalysis();
  });

  function updateDetectedBadges() {
    const badgeRow = $("#detectedBadges");
    const categories = [...new Set(
      $$(".irritant-toggle[aria-checked='true']")
        .map(toggle => toggle.dataset.category)
        .filter(Boolean)
    )];

    badgeRow.replaceChildren();

    if (!categories.length) {
      const emptyBadge = document.createElement("span");
      emptyBadge.className = "category-badge neutral";
      emptyBadge.textContent = "No irritants selected";
      badgeRow.append(emptyBadge);
      return;
    }

    categories.sort((a, b) => a.localeCompare(b)).forEach(category => {
      const badge = document.createElement("span");
      badge.className = "category-badge";
      badge.textContent = category;
      badgeRow.append(badge);
    });
  }

  $$(".irritant-toggle").forEach(toggle => {
    toggle.addEventListener("click", () => {
      const enabled = toggle.getAttribute("aria-checked") !== "true";
      toggle.setAttribute("aria-checked", String(enabled));
      toggle.closest(".ingredient-chip").classList.toggle("is-irritant", enabled);
      $("span", toggle).textContent = enabled ? toggle.dataset.category : "Safe";
      updateDetectedBadges();
    });
  });

  $("#saveMeal").addEventListener("click", () => {
    showToast("Meal saved. Nice work 🌿");
  });

  $("#discardMeal").addEventListener("click", () => {
    mealResult.hidden = true;
    captureCard.classList.remove("is-ready", "is-analyzing");
    $("#mealDescription").value = "";
    showToast("Meal discarded");
  });

  $$(".choice-group").forEach(group => {
    $$("button", group).forEach(button => {
      button.addEventListener("click", () => {
        $$("button", group).forEach(option => {
          option.setAttribute("aria-pressed", String(option === button));
        });
      });
    });
  });

  $("#gutForm").addEventListener("submit", event => {
    event.preventDefault();
    showToast("Logged. Streak: 6 days 🔥");
  });

  function openSheet(sheet) {
    if (!sheet) return;
    lastFocusedElement = document.activeElement;
    if (activeSheet && activeSheet !== sheet) activeSheet.hidden = true;
    activeSheet = sheet;
    $("#sheetScrim").hidden = false;
    sheet.hidden = false;
    document.body.style.overflow = "hidden";
    const focusTarget = $("button:not([disabled])", sheet);
    if (focusTarget) window.setTimeout(() => focusTarget.focus(), 30);
  }

  function closeSheets() {
    $$(".bottom-sheet").forEach(sheet => {
      sheet.hidden = true;
    });
    $("#sheetScrim").hidden = true;
    activeSheet = null;
    document.body.style.overflow = "";
    if (lastFocusedElement && document.contains(lastFocusedElement)) {
      lastFocusedElement.focus();
    }
  }

  $("#bristolInfoButton").addEventListener("click", () => {
    openSheet($("#bristolSheet"));
  });

  $("[id='sheetScrim']").addEventListener("click", closeSheets);

  $$("[data-close-sheet]").forEach(button => {
    button.addEventListener("click", closeSheets);
  });

  const historyFilters = $("#historyFilters");

  $$("button", historyFilters).forEach(button => {
    button.addEventListener("click", () => {
      const filter = button.dataset.filter;

      $$("button", historyFilters).forEach(filterButton => {
        filterButton.setAttribute("aria-pressed", String(filterButton === button));
      });

      $$(".timeline-item").forEach(item => {
        item.hidden = filter !== "all" && item.dataset.kind !== filter;
      });

      $$(".day-group").forEach(group => {
        group.hidden = !$(".timeline-item:not([hidden])", group);
      });
    });
  });

  const historyTimeline = $("#historyTimeline");
  const historyEmpty = $("#historyEmpty");
  const emptyToggle = $("#emptyToggle");

  emptyToggle.addEventListener("click", () => {
    const showingEmpty = !historyEmpty.hidden;
    historyEmpty.hidden = showingEmpty;
    historyTimeline.hidden = !showingEmpty;
    historyFilters.hidden = !showingEmpty;
    emptyToggle.textContent = showingEmpty ? "View empty state" : "Back to sample data";
  });

  $$(".row-menu").forEach(button => {
    button.addEventListener("click", () => {
      activeHistoryRow = button.closest(".timeline-item");
      $("#actionSheetTitle").textContent = button.dataset.title;
      openSheet($("#actionSheet"));
    });
  });

  $("#editEntry").addEventListener("click", () => {
    const title = $("#actionSheetTitle").textContent;
    closeSheets();
    showToast(`Editing “${title}” in the live app`);
  });

  $("#requestDelete").addEventListener("click", () => {
    $("#actionSheet").hidden = true;
    activeSheet = $("#confirmSheet");
    $("#confirmSheet").hidden = false;
    $("#confirmDelete").focus();
  });

  $("#confirmDelete").addEventListener("click", () => {
    if (activeHistoryRow) {
      const group = activeHistoryRow.closest(".day-group");
      activeHistoryRow.remove();

      if (group && !$(".timeline-item", group)) {
        group.remove();
      }
    }

    activeHistoryRow = null;
    closeSheets();
    showToast("Entry deleted from sample timeline");
  });

  const insightSwitch = $("#insightSwitch");
  const insightsWithData = $("#insightsWithData");
  const insightsEmpty = $("#insightsEmpty");

  $$("button", insightSwitch).forEach(button => {
    button.addEventListener("click", () => {
      const showData = button.dataset.insightState === "data";
      $$("button", insightSwitch).forEach(option => {
        option.setAttribute("aria-pressed", String(option === button));
      });
      insightsWithData.hidden = !showData;
      insightsEmpty.hidden = showData;
    });
  });

  const reportModal = $("#reportModal");

  function openReport() {
    lastFocusedElement = document.activeElement;
    reportModal.hidden = false;
    document.body.style.overflow = "hidden";
    $("#closeReport").focus();
  }

  function closeReport() {
    reportModal.hidden = true;
    document.body.style.overflow = "";
    if (lastFocusedElement && document.contains(lastFocusedElement)) {
      lastFocusedElement.focus();
    }
  }

  $("#generateReport").addEventListener("click", openReport);
  $("#closeReport").addEventListener("click", closeReport);

  $$("[data-report-action]").forEach(button => {
    button.addEventListener("click", async () => {
      const action = button.dataset.reportAction;

      if (action === "Copy" && navigator.clipboard) {
        try {
          await navigator.clipboard.writeText($("#reportPaper").innerText);
        } catch (_) {
          // The design preview still confirms the intended action.
        }
      }

      const messages = {
        Copy: "Report copied in this demo",
        Download: "Download prepared in this demo",
        Print: "Print preview prepared in this demo"
      };
      showToast(messages[action]);
    });
  });

  const chatForm = $("#chatForm");
  const chatInput = $("#chatInput");
  const chatThread = $("#chatThread");
  const typingIndicator = $("#typingIndicator");

  function appendUserMessage(text) {
    const article = document.createElement("article");
    article.className = "message user-message";

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    const paragraph = document.createElement("p");
    paragraph.textContent = text;

    bubble.append(paragraph);
    article.append(bubble);
    chatThread.insertBefore(article, typingIndicator);
  }

  function appendAssistantMessage(text) {
    const article = document.createElement("article");
    article.className = "message assistant-message";

    const avatar = document.createElement("div");
    avatar.className = "assistant-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = "U";

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    const lowerText = text.toLowerCase();

    if (lowerText.includes("add:") || lowerText.includes("toast with butter")) {
      bubble.innerHTML = "<p><strong>Added to your draft:</strong></p><ul><li>Toast</li><li>Butter · marked as dairy</li></ul><p>You can review the ingredient labels before saving.</p>";
    } else if (lowerText.includes("week")) {
      bubble.innerHTML = "<p><strong>Your week looked steadier overall.</strong></p><ul><li>5 meal-log days</li><li>4 gut check-ins</li><li>Lowest symptoms followed your gluten-clear days</li></ul><p>That’s an emerging pattern, not a diagnosis.</p>";
    } else if (lowerText.includes("yesterday")) {
      bubble.innerHTML = "<p><strong>Yesterday you logged:</strong></p><ul><li>Toast with butter at 08:16</li><li>An oat latte at 10:05</li></ul><p>Your gut check-in showed bloating 3 and Bristol 6.</p>";
    } else {
      bubble.innerHTML = "<p><strong>I checked your sample logs.</strong> I’d keep an eye on meals containing gluten, but a few more daily check-ins will make that pattern more reliable.</p>";
    }

    article.append(avatar, bubble);
    chatThread.insertBefore(article, typingIndicator);
  }

  function scrollChatToBottom() {
    window.setTimeout(() => {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "smooth"
      });
    }, 30);
  }

  function sendChatMessage(text) {
    const cleanText = text.trim();
    if (!cleanText) return;

    clearTimeout(replyTimer);
    appendUserMessage(cleanText);
    chatInput.value = "";
    typingIndicator.hidden = false;
    scrollChatToBottom();

    replyTimer = window.setTimeout(() => {
      typingIndicator.hidden = true;
      appendAssistantMessage(cleanText);
      scrollChatToBottom();
    }, 1000);
  }

  chatForm.addEventListener("submit", event => {
    event.preventDefault();
    sendChatMessage(chatInput.value);
  });

  $$("[data-suggestion]").forEach(button => {
    button.addEventListener("click", () => {
      sendChatMessage(button.dataset.suggestion);
    });
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;

    if (!reportModal.hidden) {
      closeReport();
      return;
    }

    if (activeSheet) closeSheets();
  });

  updateDetectedBadges();
  setSignupMode(false);
})();
