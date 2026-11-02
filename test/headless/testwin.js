import Gtk from 'gi://Gtk?version=4.0';
const app = new Gtk.Application({application_id: 'test.SearchBeamWin'});
app.connect('activate', () => {
    const w = new Gtk.ApplicationWindow({application: app, title: 'TestWindow', default_width: 900, default_height: 600});
    const e = new Gtk.Entry({placeholder_text: 'type here'});
    w.set_child(e);
    w.present();
});
app.run([]);
