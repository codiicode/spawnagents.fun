// SPAWN — Light/Dark Theme Toggle
// Include in <head> of every page: <script src="/theme.js"></script>
(function() {
  // Apply saved theme immediately (before paint) to prevent flash
  var saved = localStorage.getItem('spawn-theme');
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');

  // Inject light theme CSS
  var css = document.createElement('style');
  css.textContent = `
    [data-theme="light"] {
      --bg: #ffffff;
      --text: #1a1518;
      --text-muted: #6b5f63;
      --text-dim: #9e9396;
    }
    [data-theme="light"] .vignette {
      display: none;
    }
    [data-theme="light"] nav {
      background: rgba(255, 255, 255, 0.92);
    }
    [data-theme="light"] .mobile-menu {
      background: rgba(255, 255, 255, 0.97);
    }
    [data-theme="light"] .blood-drip {
      display: none;
    }
    [data-theme="light"] #particleCanvas {
      display: none;
    }
    /* Theme toggle button */
    .theme-toggle {
      background: none;
      border: 1px solid var(--border);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 14px;
      padding: 2px 8px;
      border-radius: 4px;
      transition: color 0.2s, border-color 0.2s;
      font-family: inherit;
      line-height: 1;
      display: flex;
      align-items: center;
    }
    .theme-toggle:hover {
      color: var(--text);
      border-color: var(--border-strong);
    }
  `;
  document.head.appendChild(css);

  // Add toggle button after DOM loads
  function addToggle() {
    // Desktop nav
    var navLinks = document.querySelector('.nav-links');
    if (navLinks) {
      var btn = document.createElement('button');
      btn.className = 'theme-toggle';
      btn.id = 'themeToggle';
      btn.title = 'Toggle light/dark mode';
      btn.innerHTML = document.documentElement.getAttribute('data-theme') === 'light' ? '&#9790;' : '&#9728;';
      btn.onclick = toggleTheme;
      navLinks.appendChild(btn);
    }
    // Mobile menu
    var mobileMenu = document.querySelector('.mobile-menu');
    if (mobileMenu) {
      var mbtn = document.createElement('a');
      mbtn.href = '#';
      mbtn.id = 'themeToggleMobile';
      mbtn.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark mode' : 'light mode';
      mbtn.onclick = function(e) { e.preventDefault(); toggleTheme(); };
      mobileMenu.appendChild(mbtn);
    }
  }

  function toggleTheme() {
    var isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('spawn-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('spawn-theme', 'light');
    }
    // Update button icons
    var dt = document.getElementById('themeToggle');
    var mt = document.getElementById('themeToggleMobile');
    var nowLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (dt) dt.innerHTML = nowLight ? '&#9790;' : '&#9728;';
    if (mt) mt.textContent = nowLight ? 'dark mode' : 'light mode';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addToggle);
  } else {
    addToggle();
  }

  // Expose for manual use
  window.toggleTheme = toggleTheme;
})();
