use objc2::MainThreadMarker;
use objc2::{rc::Retained, runtime::AnyObject};
use objc2_app_kit::NSEventMask;
use objc2_app_kit::{NSEvent, NSEventType};
use std::{
    cell::RefCell,
    ptr::NonNull,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
thread_local! {static MONITORS:RefCell<Vec<Retained<AnyObject>>>=const{RefCell::new(Vec::new())};}
type DragSeed = (f64, f64, f64, f64, bool);
use objc2_app_kit::{
    NSNormalWindowLevel, NSStatusWindowLevel, NSWindow, NSWindowCollectionBehavior as B,
};
use objc2_foundation::NSProcessInfo;
use serde::Serialize;
#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub level: isize,
    pub full_screen_auxiliary: bool,
    pub all_spaces: bool,
    pub all_applications: bool,
}
fn on_main<T: Send + 'static>(
    window: &tauri::WebviewWindow,
    action: impl FnOnce(&NSWindow) -> T + Send + 'static,
) -> Result<T, String> {
    let raw = window.ns_window().map_err(|_| "无法访问原生窗口")? as usize;
    if MainThreadMarker::new().is_some() {
        return Ok(action(unsafe { &*(raw as *const NSWindow) }));
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            let native = unsafe { &*(raw as *const NSWindow) };
            let _ = tx.send(action(native));
        })
        .map_err(|_| "无法更新原生窗口")?;
    rx.recv().map_err(|_| "无法读取原生窗口状态".into())
}
pub fn apply(window: &tauri::WebviewWindow, pinned: bool) -> Result<(), String> {
    on_main(window, move |native| {
        native.setAcceptsMouseMovedEvents(true);
        let mut behavior = native.collectionBehavior();
        behavior.remove(
            B::CanJoinAllSpaces
                | B::MoveToActiveSpace
                | B::FullScreenPrimary
                | B::FullScreenAuxiliary
                | B::FullScreenNone
                | B::Primary
                | B::Auxiliary
                | B::CanJoinAllApplications,
        );
        if pinned {
            behavior.insert(B::CanJoinAllSpaces | B::FullScreenAuxiliary);
            // This public flag lets accessory windows join other apps in Stage
            // Manager / full screen, rather than only their own app's space.
            if NSProcessInfo::processInfo()
                .operatingSystemVersion()
                .majorVersion
                >= 13
            {
                behavior.insert(B::CanJoinAllApplications);
            }
        }
        native.setCollectionBehavior(behavior);
        native.setLevel(if pinned {
            NSStatusWindowLevel
        } else {
            NSNormalWindowLevel
        });
    })
}
pub fn hovered(window: &tauri::WebviewWindow) -> Result<bool, String> {
    on_main(window, |native| {
        if !native.isVisible() || !native.isOnActiveSpace() {
            return false;
        }
        let point = NSEvent::mouseLocation();
        let frame = native.frame();
        point.x >= frame.origin.x
            && point.x < frame.origin.x + frame.size.width
            && point.y >= frame.origin.y
            && point.y < frame.origin.y + frame.size.height
    })
}
pub fn status(window: &tauri::WebviewWindow) -> Result<Status, String> {
    on_main(window, |native| {
        let b = native.collectionBehavior();
        Status {
            level: native.level(),
            full_screen_auxiliary: b.contains(B::FullScreenAuxiliary),
            all_spaces: b.contains(B::CanJoinAllSpaces),
            all_applications: b.contains(B::CanJoinAllApplications),
        }
    })
}
pub fn drag(window: &tauri::WebviewWindow) -> Result<(), String> {
    on_main(window, |native| {
        if NSEvent::pressedMouseButtons() & 1 == 0 {
            return;
        }
        let time = native
            .currentEvent()
            .map(|e| e.timestamp())
            .unwrap_or_else(|| NSProcessInfo::processInfo().systemUptime());
        // WebKit already consumed mouse-down when the movement threshold is
        // crossed. Hand AppKit an owned-window event; no global input is sent.
        if let Some(event)=NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDown,native.convertPointFromScreen(NSEvent::mouseLocation()),NSEvent::modifierFlags_class(),time,native.windowNumber(),None,0,1,1.0){
            native.setMovable(true);native.performWindowDragWithEvent(&event);
        }
    })
}
pub fn install_compact_drag(
    window: &tauri::WebviewWindow,
    compact: Arc<AtomicBool>,
) -> Result<(), String> {
    let raw = window.ns_window().map_err(|_| "无法访问拖动窗口")? as usize;
    on_main(window, move |_| {
        // Keep the pointer's original screen location and frame fixed. Using
        // current screen coordinates also handles coalesced mouse-drag events.
        let seed: Rc<RefCell<Option<DragSeed>>> = Rc::new(RefCell::new(None));
        let block = block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let e = unsafe { event.as_ref() };
            let native = unsafe { &*(raw as *const NSWindow) };
            if !compact.load(Ordering::SeqCst) || e.windowNumber() != native.windowNumber() {
                return event.as_ptr();
            }
            if e.r#type() == NSEventType::LeftMouseDown {
                let p = e.locationInWindow();
                let frame = native.frame();
                if p.x > 6. && p.x < frame.size.width - 56. {
                    let screen = NSEvent::mouseLocation();
                    *seed.borrow_mut() =
                        Some((screen.x, screen.y, frame.origin.x, frame.origin.y, false));
                } else {
                    *seed.borrow_mut() = None;
                }
            } else if e.r#type() == NSEventType::LeftMouseDragged {
                if let Some((x, y, fx, fy, active)) = *seed.borrow() {
                    let pointer = NSEvent::mouseLocation();
                    let dx = pointer.x - x;
                    let dy = pointer.y - y;
                    if active || dx.hypot(dy) >= 4. {
                        if !active && std::env::args().any(|a| a == "--trace-window") {
                            println!("WINDOW_DRAG_NATIVE");
                        }
                        let mut origin = native.frame().origin;
                        origin.x = fx + dx;
                        origin.y = fy + dy;
                        native.setFrameOrigin(origin);
                    }
                }
                // Mark threshold crossing after releasing the immutable borrow.
                let prior = *seed.borrow();
                if let Some((x, y, fx, fy, active)) = prior {
                    let p = NSEvent::mouseLocation();
                    if active || (p.x - x).hypot(p.y - y) >= 4. {
                        *seed.borrow_mut() = Some((x, y, fx, fy, true));
                    }
                }
            } else if e.r#type() == NSEventType::LeftMouseUp {
                *seed.borrow_mut() = None;
            }
            // WebKit still receives the ordered pointer stream, so it can
            // suppress the post-drag click and release pointer capture normally.
            event.as_ptr()
        });
        if let Some(monitor) = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::LeftMouseDown
                    | NSEventMask::LeftMouseDragged
                    | NSEventMask::LeftMouseUp,
                &block,
            )
        } {
            MONITORS.with(|items| items.borrow_mut().push(monitor));
        }
    })
}
