use age::secrecy::{ExposeSecret, SecretString};
use age::{Decryptor, Encryptor, x25519};
use anyhow::{Result, anyhow};
use std::io::{Read, Write};
use std::iter;

/// Wrapped (passphrase-encrypted) identity, relative to the notes dir.
pub const IDENTITY_FILE: &str = ".velo/identity.age";
const KEYCHAIN_SERVICE: &str = "dev.velo.app";
const KEYCHAIN_ACCOUNT: &str = "identity";

pub fn new_identity() -> String {
    x25519::Identity::generate().to_string().expose_secret().to_string()
}

fn parse_identity(identity: &str) -> Result<x25519::Identity> {
    // Parse errors are replaced so the secret can never leak into a message.
    identity.parse().map_err(|_| anyhow!("invalid age identity"))
}

pub fn encrypt(identity: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
    let recipient = parse_identity(identity)?.to_public();
    let encryptor = Encryptor::with_recipients(iter::once(&recipient as _))?;
    let mut out = Vec::new();
    let mut w = encryptor.wrap_output(&mut out)?;
    w.write_all(plaintext)?;
    w.finish()?;
    Ok(out)
}

pub fn decrypt(identity: &str, ciphertext: &[u8]) -> Result<Vec<u8>> {
    let id = parse_identity(identity)?;
    let mut out = Vec::new();
    Decryptor::new_buffered(ciphertext)?
        .decrypt(iter::once(&id as _))?
        .read_to_end(&mut out)?;
    Ok(out)
}

pub fn wrap_identity(identity: &str, passphrase: &str) -> Result<Vec<u8>> {
    let encryptor = Encryptor::with_user_passphrase(SecretString::from(passphrase.to_string()));
    let mut out = Vec::new();
    let mut w = encryptor.wrap_output(&mut out)?;
    w.write_all(identity.as_bytes())?;
    w.finish()?;
    Ok(out)
}

pub fn unwrap_identity(bytes: &[u8], passphrase: &str) -> Result<String> {
    let id = age::scrypt::Identity::new(SecretString::from(passphrase.to_string()));
    let mut out = Vec::new();
    Decryptor::new_buffered(bytes)?
        .decrypt(iter::once(&id as _))?
        .read_to_end(&mut out)?;
    let s = String::from_utf8(out).map_err(|_| anyhow!("corrupt identity"))?;
    parse_identity(&s)?; // reject anything that is not a valid identity
    Ok(s)
}

fn entry() -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
}

/// None when absent or the keychain is unavailable.
pub fn keychain_get() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn keychain_set(identity: &str) -> Result<()> {
    entry()?.set_password(identity)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test] fn roundtrip_and_no_plaintext() { let id = new_identity(); let c = encrypt(&id, b"top secret words").unwrap();
        assert!(!c.windows(6).any(|w| w == b"secret")); assert_eq!(decrypt(&id, &c).unwrap(), b"top secret words");
        assert!(decrypt(&new_identity(), &c).is_err()); }
    #[test] fn wrap_unwrap_passphrase() { let id = new_identity(); let w = wrap_identity(&id, "pw").unwrap();
        assert_eq!(unwrap_identity(&w, "pw").unwrap(), id); assert!(unwrap_identity(&w, "nope").is_err()); }
}
