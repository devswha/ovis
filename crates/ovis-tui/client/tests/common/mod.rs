//! A fake Ovis HTTP server: canned answers, one per connection, and a record of each request.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;
use std::time::Duration;

pub const WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub authorization: Option<String>,
    pub body: String,
}

pub struct Fake {
    pub origin: String,
    requests: Receiver<Recorded>,
    thread: JoinHandle<()>,
}

impl Fake {
    /// Binds before any client starts, then answers one connection per canned `(status, body)`.
    pub fn serve(answers: Vec<(u16, String)>) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let origin = format!("http://{}", listener.local_addr().expect("address"));
        let (record, requests) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            for (status, body) in answers {
                let (stream, _) = listener.accept().expect("accept");
                stream.set_read_timeout(Some(WAIT)).expect("timeout");
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                record.send(read_request(&mut reader)).expect("record");
                let mut stream = stream;
                write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .expect("answer");
            }
        });
        Fake {
            origin,
            requests,
            thread,
        }
    }

    pub fn next(&self) -> Recorded {
        self.requests.recv_timeout(WAIT).expect("a request arrives")
    }

    pub fn join(self) {
        self.thread.join().expect("fake server ends");
    }
}

fn read_request(reader: &mut BufReader<std::net::TcpStream>) -> Recorded {
    let mut line = String::new();
    reader.read_line(&mut line).expect("request line");
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let target = parts.next().unwrap_or_default().to_owned();
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
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let query = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode(key), decode(value))
        })
        .collect();
    Recorded {
        method,
        path: path.to_owned(),
        query,
        authorization,
        body: String::from_utf8(body).expect("utf-8"),
    }
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            b'%' => {
                let hex = std::str::from_utf8(&bytes[at + 1..at + 3]).expect("hex");
                out.push(u8::from_str_radix(hex, 16).expect("hex digit"));
                at += 3;
            }
            b'+' => {
                out.push(b' ');
                at += 1;
            }
            byte => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8(out).expect("utf-8")
}
