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

Compress files with zstd and generate deltas with bsdiff:

``` bash
rootfs-diff \
    --use-zstd \
    --use-bsdiff \
    --group "zstd[^/]*$" --group "^usr\/share\/alsa\/ucm" --group "^usr\/share\/mime" --group "sudo.+log" --group "fido.id" \
    squashfs.210219.zstd squashfs.210221.zstd
```

## Installing compressors

### open-vcdiff

```bash
git clone git@github.com:google/open-vcdiff.git
cd open-vcdiff
cmake -Dvcdiff_build_test=OFF
make
make install
```

#### minibsdiff

``` bash
git clone git@github.com:thoughtpolice/minibsdiff.git
cd minibsdiff
make
```

## Links

Links to different binary delta tools:

* https://github.com/google/open-vcdiff
* https://www.daemonology.net/bsdiff/
* https://github.com/thoughtpolice/minibsdiff
* https://www.chromium.org/developers/design-documents/software-updates-courgette/
* https://chromium.googlesource.com/chromium/src/components/zucchini/
* http://xdelta.org/
* https://github.com/sisong/HDiffPatch
