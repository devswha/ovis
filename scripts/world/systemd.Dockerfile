# A world machine with a systemd user manager (`--machine <name>:<engine>:all:systemd`): the CI runner image with
# systemd added. Built once, in a heavy slot (README, "The systemd machine is privileged"):
# ~/.ovis-toolchain/heavy-run.sh -- docker build -t ovis-world-systemd:local -f scripts/world/systemd.Dockerfile scripts/world
FROM herdr-ci-runner:local
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session libpam-systemd \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask systemd-networkd.service systemd-resolved.service systemd-timesyncd.service getty@tty1.service console-getty.service systemd-firstboot.service
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/sbin/init"]
