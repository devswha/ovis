//! A fake Ovis server that answers by path: each path has its answers in order, the last one
//! repeating, and every request is kept. It runs until `requests` or `close` ends it.
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::Value;

const WAIT: Duration = Duration::from_secs(5);
const STOP: &str = "/__stop";

#[derive(Debug, Clone, PartialEq)]
pub struct Asked {
    /// The method and the path with its query, as sent: `GET /api/pane/prompt?pane_id=t1`.
    pub route: String,
    pub authorization: Option<String>,
    pub body: Option<Value>,
}

pub struct Site {
    pub origin: String,
    asked: Receiver<Asked>,
    thread: Option<JoinHandle<()>>,
}

/// What a route answers, in order: `(status, body)`.
pub type Answers = Vec<(u16, Value)>;

impl Site {
    /// Binds before any client starts.
    pub fn serve(routes: Vec<(&str, Answers)>) -> Site {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("address"));
        let mut routes: BTreeMap<String, Answers> = routes
            .into_iter()
            .map(|(route, answers)| (route.to_owned(), answers))
            .collect();
        let (keep, asked) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let stream = stream.expect("a connection");
                stream.set_read_timeout(Some(WAIT)).expect("timeout");
                let request = read(&stream);
                if request.route.ends_with(STOP) {
                    break;
                }
                let (status, body) = match routes.get_mut(&request.route) {
                    Some(answers) if answers.len() > 1 => answers.remove(0),
                    Some(answers) => answers.first().cloned().expect("a route has an answer"),
                    None => (
                        404,
                        serde_json::json!({ "error": { "code": "not_found", "message": "no such route in this test" } }),
                    ),
                };
                keep.send(request).expect("the test still listens");
                answer(stream, status, &body.to_string());
            }
        });
        Site {
            origin,
            asked,
            thread: Some(thread),
        }
    }

    /// Every request since the last call, in order. Calls made through `settle` have all been
    /// answered when it returns, so nothing is still on its way.
    pub fn asked(&self) -> Vec<Asked> {
        self.asked.try_iter().collect()
    }

    /// What was posted since the last call: the route and the body of each.
    pub fn posts(&self) -> Vec<(String, Option<Value>)> {
        self.asked()
            .into_iter()
            .filter(|asked| asked.route.starts_with("POST"))
            .map(|asked| (asked.route, asked.body))
            .collect()
    }

    /// The routes asked since the last call.
    pub fn routes(&self) -> Vec<String> {
        self.asked().into_iter().map(|asked| asked.route).collect()
    }
}

impl Drop for Site {
    fn drop(&mut self) {
        let address = self.origin.trim_start_matches("http://");
        if let Ok(mut stream) = TcpStream::connect(address) {
            // the loop ends on this request; a failed write means it has ended already
            let _ = write!(stream, "GET {STOP} HTTP/1.1\r\nHost: x\r\n\r\n");
        }
        if let Some(thread) = self.thread.take() {
            // a panic of the fake is a failed assertion of its own, reported by the test that saw it
            let _ = thread.join();
        }
    }
}

fn read(stream: &TcpStream) -> Asked {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut line = String::new();
    reader.read_line(&mut line).expect("request line");
    let mut parts = line.split_whitespace();
    let route = format!(
        "{} {}",
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default()
    );
    let (mut length, mut authorization) = (0usize, None);
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).expect("header");
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':').expect("header shape");
        match name.to_ascii_lowercase().as_str() {
            "content-length" => length = value.trim().parse().expect("length"),
            "authorization" => authorization = Some(value.trim().to_owned()),
            _ => {}
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).expect("body");
    Asked {
        route,
        authorization,
        body: serde_json::from_slice(&body).ok(),
    }
}

fn answer(mut stream: TcpStream, status: u16, body: &str) {
    write!(
        stream,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .expect("answer");
}
