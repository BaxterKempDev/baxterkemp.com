(function () {
    var storageKey = 'theme';

    function systemTheme() {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function savedTheme() {
        try {
            var saved = localStorage.getItem(storageKey);
            if (saved === 'dark' || saved === 'light') {
                return saved;
            }
        } catch (e) {}
        return null;
    }

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') || savedTheme() || systemTheme();
    }

    function applyTheme(theme, persist) {
        document.documentElement.setAttribute('data-theme', theme);
        if (persist) {
            try {
                localStorage.setItem(storageKey, theme);
            } catch (e) {}
        }
    }

    function init() {
        document.querySelectorAll('[data-theme-toggle]').forEach(function (toggle) {
            toggle.addEventListener('click', function (event) {
                event.preventDefault();
                applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    var media = window.matchMedia('(prefers-color-scheme: dark)');
    var onSystemChange = function () {
        if (!savedTheme()) {
            document.documentElement.removeAttribute('data-theme');
        }
    };
    if (media.addEventListener) {
        media.addEventListener('change', onSystemChange);
    } else if (media.addListener) {
        media.addListener(onSystemChange);
    }
})();
