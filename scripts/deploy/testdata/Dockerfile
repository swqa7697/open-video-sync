FROM docker:29.9.2-dind
RUN apk add --no-cache openssh-server \
    && passwd -d root \
    && rm -f /usr/local/libexec/docker/cli-plugins/docker-compose \
      /usr/local/lib/docker/cli-plugins/docker-compose \
      /usr/libexec/docker/cli-plugins/docker-compose \
      /usr/lib/docker/cli-plugins/docker-compose
ENV DOCKER_TLS_CERTDIR=""
ENTRYPOINT ["sh", "-ec", "mkdir -p /root/.ssh; cp /fixture/client.pub /root/.ssh/authorized_keys; chmod 700 /root/.ssh; chmod 600 /root/.ssh/authorized_keys; /usr/sbin/sshd -h /fixture/host -o PasswordAuthentication=no -o PermitRootLogin=prohibit-password; exec dockerd-entrypoint.sh --tls=false --storage-driver=vfs"]
