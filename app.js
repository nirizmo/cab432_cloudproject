require('dotenv').config()

const express = require('express');

const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const AWS = require('aws-sdk');
const { default: ffmpegPath } = require('ffmpeg-static');
const app = express();

// Configure AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();
const s3BucketName = process.env.S3_BUCKET;

async function createS3bucket() {
  try {
    await s3.createBucket( { Bucket: s3BucketName }).promise();
    console.log(`Created bucket: ${s3BucketName}`);
  } catch(err) {
    if (err.statusCode === 409) {
      console.log(`Bucket successfully located: ${s3BucketName}`);
    } else {
      console.log(`Error creating bucket: ${err}`);
    }
  }
}

(async () => {
  await createS3bucket();
})();

// Configure multer to use memory storage, as we don't save files locally
const upload = multer();

// Serve static files from the "public" directory
app.use(express.static('public'));

// Define routes
app.use(express.json());

app.post('/upload', upload.single('videoFile'), (req, res) => {
  const format = req.body.format;
  const bitrate = req.body.bitrate;
  const resolution = req.body.resolution;
  const generateThumbnail = req.body.generateThumbnail;

  console.log("File Uploading...");

  // Access the uploaded file from memory
  const uploadedFileBuffer = req.file.buffer;

  // Upload the original file to S3
  const originalFileParams = {
    Bucket: s3BucketName,
    Key: 'uploads/' + req.file.originalname,
    Body: uploadedFileBuffer,
  };
  console.log("File uploaded successfully to AWS S3");


  // Setting a Ffmpeg file path ->> 'uploads/' + req.file.originalname
  const ffmpegPaath = ffmpeg.setFfmpegPath('uploads/' + req.file.originalname);
  console.log('uploads/' + req.file.originalname); // Trying t log ffmpegPaath returns undefined...

  s3.upload(originalFileParams, (err, originalFileData) => {
    if (err) {
      return res.status(500).send('Failed to upload the original file to S3');
    }

    // My changes below enable the ffmpeg to correctly execute however the .on param doesn't activate?? : )
    console.log("Debug testing Execution order: Before Ffmpeg Executes.");

    let readableVideoBuffer = new stream.PassThrough();
        readableVideoBuffer.write(uploadedFileBuffer);
        readableVideoBuffer.end();

    //console.log(readableVideoBuffer); //This code returns the PassThrough values of the stream.

    //ffmpeg -i MrStinky.mp4 -movflags faststart -acodec copy -vcodec copy output.mp4

    //Transcoding with FFmpeg
    //ffmpeg(readableVideoBuffer)
    ffmpeg('uploads/' + req.file.originalname)
      .inputFormat("mkv")
      .videoCodec(format)
      .audioCodec('aac')
      .audioBitrate(bitrate)
      .videoBitrate(bitrate)
      .size(resolution)
      .on('end', () => {
        // Transcoding complete
        if (generateThumbnail) {
          // Generate a thumbnail here if needed
        }
        console.log("Video transcoded");

        // Upload the transcoded video to S3
        const transcodedFileParams = {
          Bucket: s3BucketName,
          Key: 'transcoded/' + req.file.originalname,
          Body: uploadedFileBuffer, // Use the buffer of the uploaded file
        };
        console.log("Debug testing Execution order 2.");
        s3.upload(transcodedFileParams, (err, transcodedFileData) => {
          if (err) {
            return res.status(500).send('Failed to upload the transcoded video to S3');
          }
          // Provide download links to the user
          const downloadLink = s3.getSignedUrl('getObject', {
            Bucket: s3BucketName,
            Key: transcodedFileParams.Key,
          });

          res.json({
            message: 'Transcoding complete',
            originalFileData,
            transcodedFileData,
            downloadLink,
          });
        });
      });
      console.log("Debug testing Execution order: After Ffmpeg Executes.");
  });
});

// Start the Express server
app.listen(3000, () => {
  console.log('Server started on port 3000');
});
