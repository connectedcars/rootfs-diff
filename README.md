# rootfs-diff
Tool to compare yocto root fs to see what grows a binary diff

## Install

``` bash
npm install -g @connectedcars/rootfs-diff
```

## Usage

Simple compare:

``` bash
rootfs-diff cc-image-iwg26.squashfs.210219.zstd cc-image-iwg26.squashfs.210221.zstd
```

Compress files with zstd and generate deltas with bsdiff and courgette:

``` bash
rootfs-diff \
    --use-zstd \
    --use-bsdiff \
    --useCourgette \
    --group "zstd[^/]*$" --group "^usr\/share\/alsa\/ucm" --group "^usr\/share\/mime" --group "sudo.+log" --group "fido.id" \
    squashfs.210219.zstd squashfs.210221.zstd
```