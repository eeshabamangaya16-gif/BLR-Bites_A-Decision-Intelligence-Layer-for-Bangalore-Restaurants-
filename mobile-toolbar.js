(function () {
  function setupMobileMenu() {
    var header = document.querySelector(".site-header");
    var nav = header && header.querySelector(".site-nav");

    if (!header || !nav || header.querySelector(".mobile-menu-toggle")) {
      return;
    }

    var button = document.createElement("button");
    button.className = "mobile-menu-toggle";
    button.type = "button";
    button.setAttribute("aria-label", "Open menu");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = '<span class="mobile-menu-toggle-bars" aria-hidden="true"></span>';

    nav.id = nav.id || "mobile-primary-menu";
    button.setAttribute("aria-controls", nav.id);

    var actions = header.querySelector(".header-actions");
    header.insertBefore(button, actions || nav);

    function setOpen(isOpen) {
      header.classList.toggle("mobile-menu-open", isOpen);
      button.setAttribute("aria-expanded", String(isOpen));
      button.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
    }

    button.addEventListener("click", function () {
      setOpen(!header.classList.contains("mobile-menu-open"));
    });

    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        setOpen(false);
      }
    });

    document.addEventListener("click", function (event) {
      if (!header.contains(event.target)) {
        setOpen(false);
      }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupMobileMenu);
  } else {
    setupMobileMenu();
  }
})();
