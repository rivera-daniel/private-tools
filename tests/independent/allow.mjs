// Tags a reference tool may report on a cleaned file: structure (sizes, dimensions, codecs, sample tables),
// never descriptions, people, places, devices, software or times. Built from files written without any
// metadata (ffmpeg -map_metadata -1 -fflags +bitexact, the plain base images) and reviewed by hand.
//
// ExifTool keys are "Group1:Tag" with numbered groups (Track1, Track2) folded to "Track". A date tag on the
// list passes only when it is zero, or 1980-01-01 for ZIP entries.

const FILE = ['File:FileType', 'File:FileTypeExtension', 'File:MIMEType', 'Composite:ImageSize', 'Composite:Megapixels', 'Composite:Duration', 'Composite:AvgBitrate', 'Composite:Rotation'];
// ICC color profiles are kept on purpose so colors stay right. Their description fields are listed under
// the product decisions in the report rather than failed here.
const ICC = [/^ICC_Profile:/, /^ICC-header:/, /^ICC-meas:/, /^ICC-view:/, /^ICC-chrm:/];
const JPEG_FRAME = ['File:ImageWidth', 'File:ImageHeight', 'File:EncodingProcess', 'File:BitsPerSample', 'File:ColorComponents', 'File:YCbCrSubSampling', 'File:ExifByteOrder', /^JFIF:(JFIFVersion|ResolutionUnit|XResolution|YResolution)$/, /^Adobe:(DCTEncodeVersion|APP14Flags0|APP14Flags1|ColorTransform)$/];
const ORIENTATION = ['IFD0:Orientation', 'File:ExifByteOrder'];
const ZIP = ['ZIP:ZipRequiredVersion', 'ZIP:ZipBitFlag', 'ZIP:ZipCompression', 'ZIP:ZipModifyDate', 'ZIP:ZipCRC', 'ZIP:ZipCompressedSize', 'ZIP:ZipUncompressedSize', 'ZIP:ZipFileName'];
const QT_MOVIE = ['MajorBrand', 'MinorVersion', 'CompatibleBrands', 'Free', 'Wide', 'Skip', 'MediaDataSize', 'MediaDataOffset', 'MediaData', 'MovieHeaderVersion', 'CreateDate', 'ModifyDate', 'TimeScale', 'Duration', 'PreferredRate', 'PreferredVolume', 'MatrixStructure', 'PreviewTime', 'PreviewDuration', 'PosterTime', 'SelectionTime', 'SelectionDuration', 'CurrentTime', 'NextTrackID', 'HandlerType', 'HandlerVendorID'].map((t) => `QuickTime:${t}`);
const QT_TRACK = ['TrackHeaderVersion', 'TrackCreateDate', 'TrackModifyDate', 'TrackID', 'TrackDuration', 'TrackLayer', 'TrackVolume', 'MatrixStructure', 'ImageWidth', 'ImageHeight', 'Unknown_edts', 'MediaHeaderVersion', 'MediaCreateDate', 'MediaModifyDate', 'MediaTimeScale', 'MediaDuration', 'MediaLanguageCode', 'HandlerClass', 'HandlerType', 'GraphicsMode', 'OpColor', 'CompressorID', 'VendorID', 'SourceImageWidth', 'SourceImageHeight', 'XResolution', 'YResolution', 'CompressorName', 'BitDepth', 'AVCConfiguration', 'PixelAspectRatio', 'BufferSize', 'MaxBitrate', 'AverageBitrate', 'VideoFrameRate', 'SyncSampleTable', 'CompositionTimeToSample', 'SampleToChunk', 'SampleSizes', 'ChunkOffset', 'ChunkOffset64', 'Balance', 'AudioFormat', 'AudioChannels', 'AudioBitsPerSample', 'AudioSampleRate', 'PurchaseFileFormat', 'Unknown_mp4a', 'Unknown_esds', 'LayoutFlags', 'TimeToSampleTable', 'SampleGroupDescription', 'SampleToGroup', 'HandlerDescription', 'EditList'].map((t) => `Track:${t}`);
const MKV = ['EBMLVersion', 'EBMLReadVersion', 'EBMLMaxIDLength', 'EBMLMaxSizeLength', 'DocType', 'DocTypeVersion', 'DocTypeReadVersion', 'SeekID', 'SeekPosition', 'CRC-32', 'CueTime', 'CueTrack', 'CueClusterPosition', 'CueRelativePosition', 'Void', 'Matroska_0x0070'].map((t) => `Matroska:${t}`)
  .concat(['TimecodeScale', 'Duration', 'MuxingApp', 'WritingApp', 'CRC-32'].map((t) => `Info:${t}`))
  .concat(['TrackNumber', 'TrackUID', 'TrackLacing', 'TrackLanguage', 'TrackDefault', 'CodecID', 'TrackType', 'VideoFrameRate', 'ImageWidth', 'ImageHeight', 'DisplayWidth', 'DisplayHeight', 'VideoScanType', 'Matroska_0x15b0', 'MaxBlockAdditionID', 'CodecPrivate', 'Matroska_0x16aa', 'Matroska_0x16bb', 'DefaultDuration', 'AudioChannels', 'AudioSampleRate', 'AudioBitsPerSample', 'CodecDelay', 'SeekPreRoll'].map((t) => `Track:${t}`));

export const EXIFTOOL_ALLOW = {
  jpeg: [...FILE, ...JPEG_FRAME, ...ORIENTATION, ...ICC],
  png: [...FILE, ...ORIENTATION, ...ICC, /^PNG:(ImageWidth|ImageHeight|BitDepth|ColorType|Compression|Filter|Interlace|Gamma|SRGBRendering|WhitePointX|WhitePointY|RedX|RedY|GreenX|GreenY|BlueX|BlueY|PixelsPerUnitX|PixelsPerUnitY|PixelUnits|Palette|Transparency|BackgroundColor|SignificantBits)$/],
  webp: [...FILE, ...ORIENTATION, ...ICC, /^RIFF:(VP8Version|ImageWidth|ImageHeight|HorizontalScale|VerticalScale|WebP_Flags|AlphaPreprocessing|AlphaFiltering|AlphaCompression|BackgroundColor|AnimationLoopCount|ImageFeatures)$/],
  gif: [...FILE, /^GIF:(GIFVersion|ImageWidth|ImageHeight|HasColorMap|ColorResolutionDepth|BitsPerPixel|BackgroundColor|AnimationIterations|FrameCount|Duration|TransparentColor)$/],
  // ExifTool also reads the first embedded image of a PDF: its frame header is structure.
  pdf: [...FILE, 'PDF:PDFVersion', 'PDF:Linearized', 'PDF:PageCount', 'PDF:HasXFA', /^PDF:EmbeddedImage(Width|Height|ColorSpace|Filter|)$/, ...JPEG_FRAME],
  ooxml: [...FILE, ...ZIP], odf: [...FILE, ...ZIP], zip: [...FILE, ...ZIP],
  // The package document's manifest, spine and language are needed to open the book.
  epub: [...FILE, ...ZIP, /^XML:(Manifest|Spine)/, 'XML-dc:Language', 'XML-dc:IdentifierId', 'XML:MetaProperty', 'XML:Meta', 'XML:MetaName', 'XML:MetaContent'],
  mp4: [...FILE, ...QT_MOVIE, ...QT_TRACK, 'QuickTime:Unknown_free', 'Track:Unknown_btrt'],
  // MPEG covers the frame header and the encoder's Xing/LAME header inside the first audio frame.
  mpeg: [...FILE, 'File:ID3Size', /^MPEG:/, /^AAC:(ProfileType|SampleRate|Channels)$/],
  wav: [...FILE, /^RIFF:(Encoding|NumChannels|SampleRate|AvgBytesPerSec|BitsPerSample)$/],
  aiff: [...FILE, /^AIFF:(NumChannels|NumSampleFrames|SampleSize|SampleRate|FormatVersionTime|CompressionType|CompressorName)$/],
  // The Vorbis comment vendor string names the encoder library and is required by the format.
  flac: [...FILE, /^FLAC:(BlockSizeMin|BlockSizeMax|FrameSizeMin|FrameSizeMax|SampleRate|Channels|BitsPerSample|TotalSamples|MD5Signature|Padding|SeekTable)$/, 'Vorbis:Vendor'],
  ogg: [...FILE, /^Vorbis:(VorbisVersion|AudioChannels|SampleRate|NominalBitrate|MaximumBitrate|MinimumBitrate|Vendor)$/, /^Opus:(OpusVersion|AudioChannels|SampleRate|OutputGain)$/],
  mkv: [...FILE, ...MKV, 'Track:VideoCodecID', 'Track:AudioCodecID'],
  heif: [...FILE, 'File:ImageWidth', 'File:ImageHeight', ...ICC, /^QuickTime:(MajorBrand|MinorVersion|CompatibleBrands|HandlerType|HEVCConfigurationVersion|GeneralProfileSpace|GeneralTierFlag|GeneralProfileIDC|GenProfileCompatibilityFlags|ConstraintIndicatorFlags|GeneralLevelIDC|MinSpatialSegmentationIDC|ParallelismType|ChromaFormat|BitDepthLuma|BitDepthChroma|AverageFrameRate|ConstantFrameRate|NumTemporalLayers|TemporalIDNested|ImageSpatialExtent|CleanAperture|ImagePixelDepth|MediaDataSize|MediaDataOffset|MediaData|AV1ConfigurationVersion|SeqProfile|SeqLevelIdx0|SeqTier0|HighBitDepth|TwelveBit|MonoChrome|ChromaSubsampling\w*|ChromaSamplePosition|InitialDelaySamples|Rotation|ColorProfiles|ColorPrimaries|TransferCharacteristics|MatrixCoefficients|VideoFullRangeFlag|AuxiliaryImageType|Free)$/, 'Meta:PrimaryItemReference'],
  tiff: [...FILE, ...ICC, 'File:ExifByteOrder', /^IFD\d+:(ImageWidth|ImageHeight|BitsPerSample|Compression|PhotometricInterpretation|FillOrder|StripOffsets|Orientation|SamplesPerPixel|RowsPerStrip|StripByteCounts|PlanarConfiguration|PageNumber|WhitePoint|PrimaryChromaticities|XResolution|YResolution|ResolutionUnit|Predictor|ExtraSamples|SampleFormat|TileWidth|TileLength|TileOffsets|TileByteCounts|SubfileType|ColorMap|YCbCrSubSampling|YCbCrPositioning|ReferenceBlackWhite)$/],
  text: [...FILE, /^File:(MIMEEncoding|Newlines|LineCount|WordCount|ByteOrderMark)$/],
};

// Tags the cleaner keeps on purpose where keeping them is a product decision. They are reported, not failed.
export const EXIFTOOL_POLICY = {
  epub: [['XML-dc:Identifier', 'EPUB unique identifier (required by the format; could be replaced with a fresh one)'], ['XML-dc:Title', 'EPUB title']],
  mp4: [[/^Track:(ChapterListTrackID|Gen\w+|Text|OtherFormat|FontTable|SampleTime|SampleDuration)$/, 'chapter text track']],
  mkv: [[/^Chapter:/, 'chapters'], ['Matroska:EditionFlagDefault', 'chapters'], ['Info:SegmentUID', 'Matroska segment UID (a per-file identifier)']],
  mpeg: [['AAC:Encoder', 'encoder name inside the AAC bitstream']],
};

const DATE = /(Date|Time)$/;
const ZERO_DATE = /^0000:00:00 00:00:00/;
const ZIP_EPOCH = /^1980:01:01 00:00:00/;
// Tags that end in Date/Time but hold durations or positions, not wall-clock times.
const NOT_A_CLOCK = /(PreviewTime|PosterTime|SelectionTime|CurrentTime|CueTime|FormatVersionTime)$/;

const matches = (a, k) => (typeof a === 'string' ? a === k : a.test(k));

// Returns { left: tags that should not be there, policy: tags kept by design }.
export function exiftoolLeftovers(family, tags) {
  const allow = EXIFTOOL_ALLOW[family] ?? FILE;
  const out = []; const policy = [];
  for (const [key, value] of Object.entries(tags)) {
    if (key === 'SourceFile' || key.startsWith('System:') || key.startsWith('ExifTool:')) continue;
    const k = key.replace(/^(Track|Chapter)\d+:/, '$1:');
    const why = (EXIFTOOL_POLICY[family] ?? []).find(([a]) => matches(a, k));
    if (why) { policy.push(`${key}=${short(value)} (${why[1]})`); continue; }
    if (!allow.some((a) => matches(a, k))) { out.push(`${key}=${short(value)}`); continue; }
    if (DATE.test(k) && !NOT_A_CLOCK.test(k)) {
      const v = String(value);
      if (!(ZERO_DATE.test(v) || (k === 'ZIP:ZipModifyDate' && ZIP_EPOCH.test(v)))) out.push(`${key}=${short(value)} (time not zeroed)`);
    }
  }
  return { left: out, policy };
}

const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 80 ? `${s.slice(0, 77)}...` : s; };

// ffprobe tags that are structure, per scope.
export const FFPROBE_ALLOW = {
  format: new Set(['major_brand', 'minor_version', 'compatible_brands']),
  stream: new Set(['language', 'handler_name', 'vendor_id']),
};
