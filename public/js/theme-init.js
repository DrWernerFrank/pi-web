// Set the theme before the stylesheet paints, so dark mode never flashes white.
(function () {
	var theme = "system";
	var size = 17;
	try {
		var saved = JSON.parse(localStorage.getItem("pi-web:settings") || "{}");
		if (saved.theme) theme = saved.theme;
		if (saved.fontSize) size = saved.fontSize;
	} catch (e) {
		// defaults
	}
	if (theme === "system") theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.setProperty("--reading", size + "px");
})();
