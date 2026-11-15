//! JSON as the mux reads it (shared/relay-mux.ts parseMetadata): UTF-8, one value, and no object
//! with a key twice, even when the two are spelled with different escapes. Every string a parse
//! made is wiped when its value drops: a metadata frame or a configuration file may carry a token.

use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use zeroize::Zeroize;

pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(entries) => entries.iter().find(|(name, _)| name == key).map(|(_, value)| value),
            _ => None,
        }
    }
    pub fn is_object(&self) -> bool {
        matches!(self, Json::Object(_))
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(text) => Some(text),
            _ => None,
        }
    }
    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }
    /// An integer in `min..=max`, read as JavaScript reads one: `1.0` is 1, `1.5` is not an integer.
    pub fn as_integer(&self, min: u64, max: u64) -> Option<u64> {
        match *self {
            Json::Number(number) if number.fract() == 0.0 && number >= min as f64 && number <= max as f64 => Some(number as u64),
            _ => None,
        }
    }
}

impl Drop for Json {
    fn drop(&mut self) {
        match self {
            Json::String(text) => text.zeroize(),
            Json::Object(entries) => entries.iter_mut().for_each(|(name, _)| name.zeroize()),
            _ => {}
        }
    }
}

impl fmt::Debug for Json {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Json { .. }")
    }
}

struct JsonVisitor;

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Json;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_unit<E: de::Error>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }
    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Json, E> {
        Ok(Json::Bool(value))
    }
    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Json, E> {
        Ok(Json::Number(value as f64))
    }
    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Json, E> {
        Ok(Json::Number(value as f64))
    }
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Json, E> {
        Ok(Json::Number(value))
    }
    fn visit_str<E: de::Error>(self, value: &str) -> Result<Json, E> {
        Ok(Json::String(value.to_owned()))
    }
    fn visit_string<E: de::Error>(self, value: String) -> Result<Json, E> {
        Ok(Json::String(value))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element::<Json>()? {
            items.push(item);
        }
        Ok(Json::Array(items))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
        let mut entries: Vec<(String, Json)> = Vec::new();
        while let Some(key) = map.next_key::<String>()? {
            if entries.iter().any(|(name, _)| *name == key) {
                return Err(de::Error::custom("duplicate key"));
            }
            let value = map.next_value::<Json>()?;
            entries.push((key, value));
        }
        Ok(Json::Object(entries))
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Json, D::Error> {
        deserializer.deserialize_any(JsonVisitor)
    }
}

/// One JSON value and nothing after it but whitespace; `None` for anything else.
pub fn parse(bytes: &[u8]) -> Option<Json> {
    serde_json::from_slice(bytes).ok()
}

/// A string as `JSON.stringify` writes it.
pub fn quote(text: &str) -> String {
    serde_json::to_string(text).expect("a string always serializes")
}
