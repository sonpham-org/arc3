// Light/dark theme toggle, shared across all review-site pages.
//
// The initial theme is applied by a tiny inline snippet in each page's <head>
// (before first paint, so there is no flash). This script only wires up the
// visible toggle button(s) and keeps their icon/label in sync. It reuses the
// same localStorage key and precedence (saved choice > system preference > dark)
// as that inline snippet.
(function () {
  var KEY = "arc3-theme";

  function current() {
    return document.documentElement.getAttribute("data-theme") === "light"
      ? "light"
      : "dark";
  }

  function render(btn) {
    var light = current() === "light";
    // Icon shows the mode you'd switch TO, which is the common convention.
    btn.textContent = light ? "☽" : "☀️"; // ☽ (go dark) / ☀ (go light)
    var label = light ? "Switch to dark mode" : "Switch to light mode";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch (e) {
      /* private mode / storage disabled — theme still applies for this page */
    }
  }

  function wire() {
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    buttons.forEach(function (btn) {
      if (!btn.classList.contains("theme-toggle")) btn.classList.add("theme-toggle");
      render(btn);
      btn.addEventListener("click", function () {
        apply(current() === "light" ? "dark" : "light");
        buttons.forEach(render);
      });
    });
  }

  // Follow OS changes only while the user has not made an explicit choice.
  try {
    var mq = window.matchMedia("(prefers-color-scheme: light)");
    (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(
      function (e) {
        var saved = null;
        try {
          saved = localStorage.getItem(KEY);
        } catch (err) {}
        if (saved) return;
        document.documentElement.setAttribute("data-theme", e.matches ? "light" : "dark");
        document.querySelectorAll("[data-theme-toggle]").forEach(render);
      }
    );
  } catch (e) {}

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
