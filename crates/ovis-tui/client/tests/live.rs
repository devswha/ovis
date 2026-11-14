use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use ovis_tui_client::api::Server;
use ovis_tui_client::live::{Live, LiveEvent};
use serde_json::{Value, json};
use tungstenite::handshake::server::{Callback, ErrorResponse, Request, Response};
use tungstenite::{Message, WebSocket};

const WAIT: Duration = Duration::from_secs(5);
const FOLLOWED: [&str; 2] = ["prompt-watch", "conversation-watch"];

fn start(origin: String, token: Option<&str>) -> (Live, Receiver<LiveEvent>) {
    let (told, events) = mpsc::channel();
    let sink = Box::new(move |event: LiveEvent| told.send(event).expect("the test still listens"));
    (
        Live::start(
            Server {
                origin,
                token: token.map(str::to_owned),
            },
            sink,
        ),
        events,
    )
}

/// Hands over the path and Authorization header of the upgrade it answers.
struct Recorder(mpsc::Sender<(String, Option<String>)>);

impl Callback for Recorder {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        let bearer = request
            .headers()
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        self.0
            .send((request.uri().path().to_owned(), bearer))
            .expect("header");
        Ok(response)
    }
}

/// Accepts the next upgrade and the Authorization header it carried.
fn accept(listener: &TcpListener) -> (WebSocket<TcpStream>, Option<String>) {
    let (stream, _) = listener.accept().expect("accept");
    stream.set_read_timeout(Some(WAIT)).expect("timeout");
    let (header, seen) = mpsc::channel();
    let socket = tungstenite::accept_hdr(stream, Recorder(header)).expect("upgrade");
    let (path, bearer) = seen.recv_timeout(WAIT).expect("header seen");
    assert_eq!(path, "/ws");
    (socket, bearer)
}

/// The next frame the client sent, which must be one of the frames it may send.
fn frame(socket: &mut WebSocket<TcpStream>) -> Value {
    loop {
        match socket.read().expect("a frame") {
            Message::Text(text) => {
                let value: Value = serde_json::from_str(text.as_str()).expect("JSON");
                assert!(
                    FOLLOWED.contains(&value["type"].as_str().unwrap_or_default()),
                    "unexpected frame {value}"
                );
                return value;
            }
            Message::Ping(_) | Message::Pong(_) => {}
            other => panic!("unexpected message {other:?}"),
        }
    }
}

fn watch_pair(pane_id: &str, enabled: bool) -> Vec<Value> {
    vec![
        json!({ "type": "prompt-watch", "pane_id": pane_id, "enabled": enabled }),
        json!({ "type": "conversation-watch", "pane_id": pane_id, "enabled": enabled, "detached": true }),
    ]
}

fn next(events: &Receiver<LiveEvent>) -> LiveEvent {
    events.recv_timeout(WAIT).expect("an event")
}

#[test]
fn follows_frames_moves_the_watch_and_reconnects_after_a_drop() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let (live, events) = start(
        format!("http://{}", listener.local_addr().expect("address")),
        Some("s3"),
    );
    let (mut socket, bearer) = accept(&listener);
    assert_eq!(bearer.as_deref(), Some("Bearer s3"));
    assert_eq!(next(&events), LiveEvent::Up);

    live.watch(Some("w:1"));
    assert_eq!(
        vec![frame(&mut socket), frame(&mut socket)],
        watch_pair("w:1", true)
    );

    let snapshot = json!({ "type": "snapshot", "snapshot": { "panes": [{ "pane_id": "w:1", "agent_status": "idle" }] } });
    socket
        .send(Message::text(
            json!({ "type": "features", "features": [], "connection": "c" }).to_string(),
        ))
        .expect("send");
    socket
        .send(Message::text(snapshot.to_string()))
        .expect("send");
    socket
        .send(Message::text(
            json!({ "type": "prompt-changed", "pane_id": "w:1", "signature": "s" }).to_string(),
        ))
        .expect("send");
    match next(&events) {
        LiveEvent::Snapshot(snapshot) => assert_eq!(snapshot.panes[0].pane_id, "w:1"),
        other => panic!("expected a snapshot, got {other:?}"),
    }
    assert_eq!(next(&events), LiveEvent::PromptChanged("w:1".to_owned()));

    live.watch(Some("w:2"));
    let moved: Vec<Value> = (0..4).map(|_| frame(&mut socket)).collect();
    assert_eq!(
        moved,
        [watch_pair("w:1", false), watch_pair("w:2", true)].concat()
    );

    socket.close(None).expect("close");
    while socket.read().is_ok() {}
    drop(socket);
    assert!(matches!(next(&events), LiveEvent::Down(_)));

    let (mut again, _) = accept(&listener);
    assert_eq!(next(&events), LiveEvent::Up);
    assert_eq!(
        vec![frame(&mut again), frame(&mut again)],
        watch_pair("w:2", true)
    );
    live.stop();
}

#[test]
fn sends_no_authorization_without_a_token() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let (live, events) = start(
        format!("http://{}", listener.local_addr().expect("address")),
        None,
    );
    let (_socket, bearer) = accept(&listener);
    assert_eq!((bearer, next(&events)), (None, LiveEvent::Up));
    live.stop();
}

#[test]
fn an_https_origin_is_down_until_stopped() {
    let (live, events) = start("https://127.0.0.1:1".to_owned(), None);
    assert_eq!(
        next(&events),
        LiveEvent::Down("https origins are not supported yet".to_owned())
    );
    live.stop();
}
