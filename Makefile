UUID := search-beam@kingsleycj.github.io
ZIP  := build/$(UUID).shell-extension.zip

.PHONY: pack install clean

pack:
	mkdir -p build
	gnome-extensions pack --force --extra-source=popup.js --extra-source=answers.js --extra-source=answerView.js --extra-source=previewInfo.js --extra-source=previewView.js --extra-source=LICENSE --out-dir=build .

install: pack
	gnome-extensions install --force $(ZIP)
	glib-compile-schemas $(HOME)/.local/share/gnome-shell/extensions/$(UUID)/schemas
	@echo "Installed. Log out and back in (Wayland loads extensions at login), then run:"
	@echo "  gnome-extensions enable $(UUID)"

clean:
	rm -rf build
