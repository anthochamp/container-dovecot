require "fileinto";

if header :contains "X-Spam" "YES" {
  fileinto "Junk";
}
