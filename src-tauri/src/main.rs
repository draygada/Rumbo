use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
    Listener,
    WindowEvent,
    RunEvent,
};
use tauri_plugin_global_shortcut::ShortcutState;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let is_logged_in = Arc::new(AtomicBool::new(false));
            let is_logged_in_for_listener = is_logged_in.clone();

            // Frontend emits this whenever auth session changes.
            // Payload: JSON boolean
            app.listen("rumbo:auth-session", move |event| {
                let logged_in = serde_json::from_str::<bool>(event.payload()).unwrap_or(false);
                is_logged_in_for_listener.store(logged_in, Ordering::Relaxed);
                println!("auth-session event: logged_in={logged_in}");
            });

            // Build tray menu items
            let open_rumbo = MenuItemBuilder::new("Open Rumbo")
                .id("open-rumbo")
                .build(app)?;

            let add_task = MenuItemBuilder::new("Add task")
                .id("add-task")
                .build(app)?;

            let quit = MenuItemBuilder::new("Quit").id("quit").build(app)?;

            let tray_menu = MenuBuilder::new(app)
                .item(&open_rumbo)
                .item(&add_task)
                .separator()
                .item(&quit)
                .build()?;

            // Create tray icon and wire menu events using window management from spec
            TrayIconBuilder::new()
                .menu(&tray_menu)
                .on_menu_event(|tray, event| {
                    let app = tray.app_handle();

                    match event.id().as_ref() {
                        // Reuse/focus main dashboard window
                        "open-rumbo" => {
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                        // Reuse/focus quick-add modal window
                        "add-task" => {
                            if let Some(win) = app.get_webview_window("quick-add") {
                                let _ = win.show();
                                let _ = win.center();
                                let _ = win.set_focus();
                            }
                        }
                        // Quit entire app
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Register global shortcut to toggle quick-add window.
            // On macOS: Cmd+Shift+Space, on Windows: Ctrl+Shift+Space.
            #[cfg(target_os = "macos")]
            {
                let is_logged_in_for_handler = is_logged_in.clone();
                let plugin = tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["CmdOrCtrl+Shift+Space"])
                    .map(|builder| {
                        builder
                            .with_handler(move |app, _shortcut, event| {
                                if event.state == ShortcutState::Pressed {
                                    if !is_logged_in_for_handler.load(Ordering::Relaxed) {
                                        return;
                                    }
                                    if let Some(win) = app.get_webview_window("quick-add") {
                                        if win.is_visible().unwrap_or(false) {
                                            let _ = win.hide();
                                        } else {
                                            let _ = win.show();
                                            let _ = win.center();
                                            let _ = win.set_focus();
                                        }
                                    }
                                }
                            })
                            .build()
                    });

                // Ignore registration failure (e.g. permission denied).
                if let Ok(plugin) = plugin {
                    let _ = app.handle().plugin(plugin);
                }
            }

            #[cfg(target_os = "windows")]
            {
                let is_logged_in_for_handler = is_logged_in.clone();
                let plugin = tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["Ctrl+Shift+Space"])
                    .map(|builder| {
                        builder
                            .with_handler(move |app, _shortcut, event| {
                                if event.state == ShortcutState::Pressed {
                                    if !is_logged_in_for_handler.load(Ordering::Relaxed) {
                                        return;
                                    }
                                    if let Some(win) = app.get_webview_window("quick-add") {
                                        if win.is_visible().unwrap_or(false) {
                                            let _ = win.hide();
                                        } else {
                                            let _ = win.show();
                                            let _ = win.center();
                                            let _ = win.set_focus();
                                        }
                                    }
                                }
                            })
                            .build()
                    });

                // Ignore registration failure.
                if let Ok(plugin) = plugin {
                    let _ = app.handle().plugin(plugin);
                }
            }

            // Red ✕ on the main window hides it instead of destroying it.
            // This keeps the app alive in the background so the tray icon,
            // global hotkey, and Dock-click reopen all keep working.
            if let Some(main_win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            // Hide quick-add whenever it loses OS-level focus.
            // JS onFocusChanged / window.blur is not always reliable for non-app targets on macOS.
            if let Some(quick_add) = app.get_webview_window("quick-add") {
                let handle = app.handle().clone();
                quick_add.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        if let Some(w) = handle.get_webview_window("quick-add") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app, event| match event {
            // Prevent the app from quitting when the last window is closed.
            // The tray icon and global hotkey stay active in the background.
            RunEvent::ExitRequested { api, .. } => {
                api.prevent_exit();
            }
            // macOS: user clicked the Dock icon while no windows are visible.
            // Re-show the main window just like any normal Mac app.
            RunEvent::Reopen { .. } => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            _ => {}
        });
}
