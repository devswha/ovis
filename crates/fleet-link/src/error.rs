use std::fmt;

/// Why a handshake or a record was refused. The texts are those the TypeScript code throws
/// (shared/vendor/paseo-e2ee), so server/fleet/vectors/records.json names the same refusal for
/// both. No variant carries data: a failure can never print a byte it was given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    AuthenticationFailed,
    NonceExhausted,
    HandshakeMessageTooLarge,
    HandshakeMessageTruncated,
    InvalidDhPublicKey,
    InvalidParameterPayload,
    UnsupportedParameterVersion,
    ReservedParameterFlag,
    FrameTooLarge,
    RecordTruncated,
    InvalidChunkLength,
    ReservedFlag,
    InvalidFrameKind,
    UnexpectedChunkAfterFinal,
    EmptyRecord,
    RecordIncomplete,
    RecordNotFirst,
    RecordLengthMismatch,
    FirstRepeated,
    FrameKindChanged,
    FrameLengthChanged,
    FinalFlagMismatch,
    ChunkSizeMismatch,
    CarrierMessageTooLarge,
    InvalidText,
    Closed,
}

impl Error {
    pub fn message(self) -> &'static str {
        match self {
            Error::AuthenticationFailed => "authentication failed",
            Error::NonceExhausted => "nonce exhausted",
            Error::HandshakeMessageTooLarge => "handshake message too large",
            Error::HandshakeMessageTruncated => "handshake message truncated",
            Error::InvalidDhPublicKey => "invalid DH public key",
            Error::InvalidParameterPayload => "invalid parameter payload",
            Error::UnsupportedParameterVersion => "unsupported parameter version",
            Error::ReservedParameterFlag => "reserved parameter flag set",
            Error::FrameTooLarge => "frame too large",
            Error::RecordTruncated => "record truncated",
            Error::InvalidChunkLength => "invalid chunk length",
            Error::ReservedFlag => "reserved flag set",
            Error::InvalidFrameKind => "invalid frame kind",
            Error::UnexpectedChunkAfterFinal => "unexpected chunk after final",
            Error::EmptyRecord => "empty record",
            Error::RecordIncomplete => "record incomplete",
            Error::RecordNotFirst => "record does not start with FIRST",
            Error::RecordLengthMismatch => "record length mismatch",
            Error::FirstRepeated => "FIRST repeated inside record",
            Error::FrameKindChanged => "frame kind changed inside record",
            Error::FrameLengthChanged => "frame length changed inside record",
            Error::FinalFlagMismatch => "FINAL flag mismatch",
            Error::ChunkSizeMismatch => "chunk size mismatch",
            // shared/relay-e2ee.ts guardCarrier's close reason
            Error::CarrierMessageTooLarge => "Carrier message too large",
            Error::InvalidText => "text frame is not UTF-8",
            Error::Closed => "channel closed",
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for Error {}
